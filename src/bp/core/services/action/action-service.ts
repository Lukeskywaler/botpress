import axios from 'axios'
import { IO, Logger } from 'botpress/sdk'
import { ObjectCache } from 'common/object-cache'
import { ActionDefinition, ActionLocation, ActionServer } from 'common/typings'
import { UntrustedSandbox } from 'core/misc/code-sandbox'
import { printObject } from 'core/misc/print'
import { TasksRepository } from 'core/repositories/tasks'
import { AUDIENCE } from 'core/routers/sdk/utils'
import { injectable } from 'inversify'
import { inject, tagged } from 'inversify'
import jsonwebtoken from 'jsonwebtoken'
import _ from 'lodash'
import ms from 'ms'
import path from 'path'
import { NodeVM } from 'vm2'
import yn from 'yn'

import { GhostService } from '..'
import { createForAction } from '../../api'
import { clearRequireCache, requireFromString } from '../../modules/require'
import { TYPES } from '../../types'
import { ActionExecutionError } from '../dialog/errors'
import { WorkspaceService } from '../workspace-service'

import { extractMetadata } from './metadata'
import { enabled, extractRequiredFiles, getBaseLookupPaths, prepareRequire, prepareRequireTester } from './utils'
import { VmRunner } from './vm'

const debug = DEBUG('actions')
const DEBOUNCE_DELAY = ms('2s')

// node_production_modules are node_modules that are compressed for production
const EXCLUDES = ['**/node_modules/**', '**/node_production_modules/**']

@injectable()
export default class ActionService {
  private _scopedActions: Map<string, ScopedActionService> = new Map()
  private _invalidateDebounce

  constructor(
    @inject(TYPES.GhostService) private ghost: GhostService,
    @inject(TYPES.ObjectCache) private cache: ObjectCache,
    @inject(TYPES.TasksRepository) private tasksRepository: TasksRepository,
    @inject(TYPES.WorkspaceService) private workspaceService: WorkspaceService,
    @inject(TYPES.Logger)
    @tagged('name', 'ActionService')
    private logger: Logger
  ) {
    this._listenForCacheInvalidation()
    this._invalidateDebounce = _.debounce(this._invalidateRequire, DEBOUNCE_DELAY, { leading: true, trailing: false })
  }

  forBot(botId: string): ScopedActionService {
    if (this._scopedActions.has(botId)) {
      return this._scopedActions.get(botId)!
    }

    const scopedActionService = new ScopedActionService(
      this.ghost,
      this.logger,
      botId,
      this.cache,
      this.tasksRepository,
      this.workspaceService
    )
    this._scopedActions.set(botId, scopedActionService)
    return scopedActionService
  }

  private _listenForCacheInvalidation() {
    this.cache.events.on('invalidation', key => {
      if (key.toLowerCase().indexOf(`/actions`) > -1) {
        this._invalidateDebounce(key)
      }
    })
  }

  // Debouncing invalidate since we get a lot of events when it happens
  private _invalidateRequire() {
    Object.keys(require.cache)
      .filter(r => r.match(/(\\|\/)actions(\\|\/)/g))
      .map(file => delete require.cache[file])

    clearRequireCache()
  }
}

interface RunActionProps {
  actionName: string
  actionServer?: ActionServer
  incomingEvent: IO.IncomingEvent
  actionArgs: any
}

export class ScopedActionService {
  private _globalActionsCache: ActionDefinition[] | undefined
  private _localActionsCache: ActionDefinition[] | undefined
  private _scriptsCache: Map<string, string> = new Map()
  // Keeps a quick index of files which have already been required
  private _validScripts: { [filename: string]: boolean } = {}
  private _botsWorkspaceIdsCache: Map<string, string> = new Map()

  constructor(
    private ghost: GhostService,
    private logger: Logger,
    private botId: string,
    private cache: ObjectCache,
    private tasksRepository: TasksRepository,
    private workspaceService: WorkspaceService
  ) {
    this._listenForCacheInvalidation()
  }

  async listActions(): Promise<ActionDefinition[]> {
    const globalActions = await this.listGlobalActions()
    const localActions = await this.listLocalActions()

    return globalActions.concat(localActions)
  }

  async hasAction(actionName: string): Promise<boolean> {
    const actions = await this.listActions()
    return !!actions.find(x => x.name === actionName)
  }

  public async listLocalActions() {
    if (this._localActionsCache) {
      return this._localActionsCache
    }

    const actionFiles = (await this.ghost.forBot(this.botId).directoryListing('actions', '*.js', EXCLUDES)).filter(
      enabled
    )
    const actions = await Promise.map(actionFiles, async file => this.getActionDefinition(file, 'local', true))

    this._localActionsCache = actions
    return actions
  }

  async runAction(props: RunActionProps): Promise<void> {
    const { actionName, actionArgs, actionServer } = props
    let { incomingEvent } = props
    process.ASSERT_LICENSED()

    debug.forBot(incomingEvent.botId, 'run action', { actionName, incomingEvent, actionArgs })

    try {
      if (actionServer) {
        incomingEvent = await this.runInActionServer({ ...props, actionServer })
      } else {
        const trusted = await this.isTrustedAction(actionName)

        if (trusted) {
          await this.runTrustedCode(actionName, actionArgs, incomingEvent)
        } else {
          await this.runLegacyAction(actionName, actionArgs, incomingEvent)
        }
      }

      debug.forBot(incomingEvent.botId, 'done running', { actionName, actionArgs })
    } catch (err) {
      this.logger
        .forBot(this.botId)
        .attachError(err)
        .error(`An error occurred while executing the action "${actionName}`)
      throw new ActionExecutionError(err.message, actionName, err.stack)
    }
  }

  private async listGlobalActions() {
    if (this._globalActionsCache) {
      return this._globalActionsCache
    }

    const actionFiles = (await this.ghost.global().directoryListing('actions', '*.js', EXCLUDES)).filter(enabled)
    const actions = await Promise.map(actionFiles, async file => this.getActionDefinition(file, 'global', true))

    this._globalActionsCache = actions
    return actions
  }

  private async runInActionServer(props: {
    actionServer: ActionServer
    actionName: string
    incomingEvent: IO.IncomingEvent
    actionArgs: any
  }): Promise<IO.IncomingEvent> {
    const { actionName, actionArgs, actionServer, incomingEvent } = props
    const botId = incomingEvent.botId

    const workspaceId = await this.getWorkspaceIdForBot(botId)

    const token = jsonwebtoken.sign({ botId, scopes: ['*'], workspace: workspaceId }, process.APP_SECRET, {
      expiresIn: '5m',
      audience: AUDIENCE
    })

    const startedAt = new Date()
    const taskInfo = {
      eventId: incomingEvent.id,
      actionName,
      actionArgs,
      actionServerId: actionServer.id,
      startedAt
    }

    let response
    try {
      response = await axios({
        method: 'post',
        url: `${actionServer.baseUrl}/action/run`,
        timeout: ms('5s'),
        data: { token, botId, ..._.omit(props, ['actionServer']) },
        // I override validateStatus in order for axios to not throw the Action Server returns a 500 error.
        // See https://github.com/axios/axios/issues/1143#issuecomment-340331822
        validateStatus: status => {
          return true
        }
      })
    } catch (e) {
      if (e.isAxiosError) {
        this.tasksRepository.createTask({
          ...taskInfo,
          endedAt: new Date(),
          status: 'failed',
          failureReason: `axios:${e.code}`
        })
      }

      throw e
    }

    const responseStatusCode = response.status

    this.tasksRepository.createTask({
      ...taskInfo,
      endedAt: new Date(),
      status: 'completed'
    })

    const responseIncomingEvent = response.data.incomingEvent

    responseIncomingEvent.state.temp.responseStatusCode = responseStatusCode

    return responseIncomingEvent
  }

  private async runTrustedCode(actionName: string, actionArgs: any, incomingEvent: IO.IncomingEvent) {
    const { code, _require } = await this.loadLocalAction(actionName)

    const api = await createForAction()

    const args = {
      bp: api,
      event: incomingEvent,
      user: incomingEvent.state.user,
      temp: incomingEvent.state.temp,
      session: incomingEvent.state.session,
      args: actionArgs,
      printObject,
      process: UntrustedSandbox.getSandboxProcessArgs()
    }

    return await this.runWithoutVm(code, args, _require)
  }

  private async runLegacyAction(actionName: string, actionArgs: any, incomingEvent: IO.IncomingEvent) {
    const { code, _require, dirPath } = await this.loadLocalAction(actionName)

    const api = await createForAction()

    const args = {
      bp: api,
      event: incomingEvent,
      user: incomingEvent.state.user,
      temp: incomingEvent.state.temp,
      session: incomingEvent.state.session,
      args: actionArgs,
      printObject,
      process: UntrustedSandbox.getSandboxProcessArgs()
    }

    return await this.runInVm(code, dirPath, args, _require)
  }

  public async runInVm(code: string, dirPath: string, args: any, _require: Function) {
    const modRequire = new Proxy(
      {},
      {
        get: (_obj, prop) => _require(prop)
      }
    )

    const vm = new NodeVM({
      wrapper: 'none',
      sandbox: args,
      require: {
        external: true,
        mock: modRequire
      },
      timeout: 5000
    })

    const runner = new VmRunner()
    return runner.runInVm(vm, code, dirPath)
  }

  private async getActionDetails(actionName: string) {
    const action = await this.findAction(actionName)
    const code = await this.getActionScript(action)

    const botFolder = action.location === 'global' ? 'global' : 'bots/' + this.botId
    const dirPath = path.resolve(path.join(process.PROJECT_LOCATION, `/data/${botFolder}/actions/${actionName}.js`))
    const lookups = getBaseLookupPaths(dirPath)

    return { code, dirPath, lookups, action }
  }

  public async loadLocalAction(actionName: string) {
    if (yn(process.core_env.BP_EXPERIMENTAL_REQUIRE_BPFS)) {
      await this.checkActionRequires(actionName)
    }

    const { code, dirPath, lookups } = await this.getActionDetails(actionName)

    const _require = prepareRequire(dirPath, lookups)

    return { code, _require, dirPath }
  }

  private _listenForCacheInvalidation() {
    const clearDebounce = _.debounce(this._clearCache.bind(this), DEBOUNCE_DELAY, { leading: true, trailing: false })

    this.cache.events.on('invalidation', key => {
      if (key.toLowerCase().indexOf(`/actions`) > -1) {
        clearDebounce()
      }
    })
  }

  private _clearCache() {
    this._scriptsCache.clear()
    this._globalActionsCache = undefined
    this._localActionsCache = undefined
    this._validScripts = {}
    this._botsWorkspaceIdsCache.clear()
  }

  private async getActionDefinition(
    file: string,
    location: ActionLocation,
    includeMetadata: boolean
  ): Promise<ActionDefinition> {
    let action: ActionDefinition = {
      name: file.replace(/\.js|\.http\.js$/i, ''),
      isRemote: false,
      location: location,
      legacy: !file.includes('.http.js')
    }

    if (includeMetadata) {
      const script = await this.getActionScript(action)
      action = { ...action, metadata: extractMetadata(script) }
    }

    return action
  }

  private async getActionScript(action: ActionDefinition): Promise<string> {
    if (this._scriptsCache.has(action.name)) {
      return this._scriptsCache.get(action.name)!
    }

    let script: string
    if (action.location === 'global') {
      script = await this.ghost.global().readFileAsString('actions', action.name + '.js')
    } else {
      const filename = action.legacy ? action.name + '.js' : action.name + '.http.js'
      script = await this.ghost.forBot(this.botId).readFileAsString('actions', filename)
    }

    this._scriptsCache.set(`${action.name}_${action.legacy}_${action.location}`, script)
    return script
  }

  private async isTrustedAction(actionName: string): Promise<boolean> {
    const trustedActions = await this.listTrustedActions()
    return trustedActions.map(a => a.name).includes(actionName)
  }

  private async listTrustedActions(): Promise<ActionDefinition[]> {
    const BUILTIN_MODULES = [
      'analytics',
      'basic-skills',
      'builtin',
      'builtin',
      'channel-messenger',
      'channel-slack',
      'channel-teams',
      'channel-telegram',
      'channel-web',
      'code-editor',
      'examples',
      'extensions',
      'history',
      'hitl',
      'nlu',
      'qna',
      'testing'
    ]

    const globalActions = await this.listGlobalActions()
    return globalActions.filter(a => BUILTIN_MODULES.includes(a.name.split('/')[0]))
  }

  // This method tries to load require() files from the FS and fallback on BPFS
  private async checkActionRequires(actionName: string): Promise<boolean> {
    if (this._validScripts[actionName]) {
      return true
    }

    const { code, dirPath: parentScript, lookups } = await this.getActionDetails(actionName)

    const isRequireValid = prepareRequireTester(parentScript, lookups)
    const files = extractRequiredFiles(code)

    for (const file of files) {
      if (isRequireValid(file)) {
        continue
      }

      try {
        // Ensures the required files are available before compiling the action
        await this.checkActionRequires(file)

        const { code, dirPath, lookups } = await this.getActionDetails(file)
        const exports = requireFromString(code, file, parentScript, prepareRequire(dirPath, lookups))

        if (_.isEmpty(exports)) {
          this.logger.warn(`Your required file (${file}) looks empty. Missing module.exports ? `)
        }
      } catch (err) {
        this.logger.attachError(err).error(`There is an issue with required file ${file}.js in action ${actionName}.js`)
        return false
      }
    }

    this._validScripts[actionName] = true
    return true
  }

  private async runWithoutVm(code: string, args: any, _require: Function) {
    args = {
      ...args,
      require: _require
    }

    const fn = new Function(...Object.keys(args), code)
    return fn(...Object.values(args))
  }

  private async findAction(actionName: string): Promise<ActionDefinition> {
    const actions = await this.listActions()
    const action = actions.find(x => x.name === actionName)

    if (!action) {
      throw new Error(`Action "${actionName}" not found`)
    }

    return action
  }

  private async getWorkspaceIdForBot(botId: string): Promise<string> {
    let workspaceId
    if (this._botsWorkspaceIdsCache.has(botId)) {
      workspaceId = this._botsWorkspaceIdsCache.get(botId)
    } else {
      workspaceId = await this.workspaceService.getBotWorkspaceId(botId)
      this._botsWorkspaceIdsCache.set(botId, workspaceId)
    }

    return workspaceId
  }
}
