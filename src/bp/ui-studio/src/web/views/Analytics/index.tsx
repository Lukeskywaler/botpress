import { Card, HTMLSelect } from '@blueprintjs/core'
import { DateRange, DateRangeInput } from '@blueprintjs/datetime'
import '@blueprintjs/datetime/lib/css/blueprint-datetime.css'
import axios from 'axios'
import _ from 'lodash'
import moment from 'moment'
import React from 'react'
import { Area, AreaChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import style from './style.scss'

const colorSlack = '#4A154B'
const colorMessenger = '#0196FF'
const colorWeb = '#FFA83A'
const colorTelegram = '#2EA6DA'

export default class Analytics extends React.Component<{ bp: any }> {
  state = {
    channels: ['all'],
    selectedChannel: 'all',
    metrics: [],
    startDate: undefined,
    endDate: undefined
  }

  componentDidMount() {
    void axios.get(`${window.API_PATH}/modules`).then(({ data }) => {
      const channels = data
        .filter(
          x =>
            x.name === 'channel-web' ||
            x.name === 'channel-messenger' ||
            x.name === 'channel-slack' ||
            x.name === 'channel-telegram'
        )
        .map(x => x.name.substring(8))

      this.setState({ channels: [...this.state.channels, ...channels] })
    })

    const aWeekAgo = moment()
      .subtract(7, 'days')
      .startOf('day')
      .unix()
    const today = moment()
      .startOf('day')
      .unix()

    void this.fetchAnalytics(this.state.selectedChannel, aWeekAgo, today).then(({ data }) => {
      this.setState({ startDate: aWeekAgo, endDate: today, metrics: data })
    })
  }

  fetchAnalytics = (channel, startDate, endDate) => {
    return axios.get(`${window.BOT_API_PATH}/analytics/channel/${channel}`, {
      params: {
        start: startDate,
        end: endDate
      }
    })
  }

  handleFilterChange = event => {
    this.fetchAnalytics(event.target.value, this.state.startDate, this.state.endDate).then(({ data }) => {
      this.setState({ metrics: data })
    })
  }

  handleDateChange = async (dateRange: DateRange) => {
    const startDate = moment(dateRange[0]).unix()
    const endDate = moment(dateRange[1]).unix()

    const { data } = await this.fetchAnalytics(this.state.selectedChannel, startDate, endDate)
    this.setState({ startDate, endDate, metrics: data })
  }

  isLoaded = () => {
    return this.state.metrics && this.state.startDate && this.state.endDate
  }

  capitalize = str => str.substring(0, 1).toUpperCase() + str.substring(1)

  renderDateInput() {
    const startDate = moment.unix(this.state.startDate).toDate()
    const endDate = moment.unix(this.state.endDate).toDate()
    return (
      <DateRangeInput
        closeOnSelection={false}
        formatDate={date => moment(date).format('MMMM Do YYYY')}
        maxDate={new Date()}
        parseDate={str => new Date(str)}
        onChange={this.handleDateChange}
        value={[startDate, endDate]}
      />
    )
  }

  render() {
    if (this.isLoaded()) {
      return (
        <div>
          <div className={style.header}>
            Filter by&nbsp;
            <HTMLSelect onChange={this.handleFilterChange} defaultValue="all">
              {this.state.channels.map(channel => {
                return <option value={channel}>{this.capitalize(channel)}</option>
              })}
            </HTMLSelect>
            {this.renderDateInput()}
          </div>
          {this.renderAgentUsage()}
          {this.renderEngagement()}
          {this.renderUnderstanding()}
        </div>
      )
    }

    return null
  }

  getMetricCount = metricName =>
    this.state.metrics.filter(m => m.metric_name === metricName).reduce((acc, cur) => acc + cur.value, 0)

  getAvgMsgPerSessions = () => {
    const augmentedMetrics = this.state.metrics.map(m => ({
      ...m,
      day: moment(m.created_on).format('DD-MM')
    }))
    const metricsByDate = _.sortBy(augmentedMetrics, 'day')
    const sessionsCountPerDay = metricsByDate.filter(m => m.metric_name === 'sessions_count')

    return sessionsCountPerDay.map(s => {
      const sentCount = augmentedMetrics.find(
        m => m.metric_name === 'msg_sent_count' && s.day === m.day && s.channel === m.channel
      )
      const receivedCount = augmentedMetrics.find(
        m => m.metric_name === 'msg_received_count' && s.day === m.day && s.channel === m.channel
      )
      return {
        value: Math.round((_.get(sentCount, 'value', 0) + _.get(receivedCount, 'value', 0)) / s.value),
        channel: s.channel,
        created_on: s.created_on
      }
    })
  }

  getUnderstoodPercent = () => {
    const received = this.getMetricCount('msg_received_count')
    const none = this.getMetricCount('msg_nlu_none')
    const percent = ((received - none) / received) * 100
    return percent.toFixed(2) + '%'
  }

  getReturningUsers = () => {
    const usersCount = this.getMetricCount('users_count')
    const newUsersCount = this.getMetricCount('new_users_count')
    return ((newUsersCount / usersCount) * 100).toFixed(2) + '%'
  }

  getMetric = metricName => this.state.metrics.filter(x => x.metric_name === metricName)

  renderAgentUsage() {
    return (
      <div className={style.metricsSection}>
        <h3>Agent Usage</h3>
        <div className={style.metricsContainer}>
          {this.renderTimeSeriesChart('Sessions', this.getMetric('sessions_count'))}
          {this.renderTimeSeriesChart('Messages Received', this.getMetric('msg_received_count'))}
          {this.renderTimeSeriesChart('Goals Started', this.getMetric('goals_started_count'))}
          {this.renderTimeSeriesChart('Goals Completed', this.getMetric('goals_completed_count'))}
          {this.renderTimeSeriesChart('QNA Sent', this.getMetric('msg_sent_qna_count'))}
        </div>
      </div>
    )
  }

  renderEngagement() {
    return (
      <div className={style.metricsSection}>
        <h3>Engagement & Retention</h3>
        <div className={style.metricsContainer}>
          {this.renderTimeSeriesChart('Average Session Length', this.getAvgMsgPerSessions())}
          {this.renderTimeSeriesChart('Total Users', this.getMetric('users_count'))}
          {this.renderTimeSeriesChart('New Users', this.getMetric('new_users_count'))}
          {this.renderNumberMetric('Returning Users', this.getReturningUsers())}
        </div>
      </div>
    )
  }

  renderUnderstanding() {
    const goalsOutcome = this.getMetricCount('goals_completed_count') / this.getMetricCount('goals_started_count') || 0

    return (
      <div className={style.metricsSection}>
        <h3>Understanding</h3>
        <div className={style.metricsContainer}>
          {this.renderNumberMetric('# Positive Goals Outcome', goalsOutcome)}
          {this.renderNumberMetric('# Positive QNA Feedback', this.getMetricCount('feedback_positive_count'))}
          {this.renderNumberMetric('# Understood Messages', this.getUnderstoodPercent())}
          {this.renderNumberMetric('# Understood Top-Level Messages', 666)}
        </div>
      </div>
    )
  }

  renderNumberMetric(name, value) {
    return (
      <Card className={style.numberMetric}>
        <h4 className={style.numberMetricName}>{name}</h4>
        <h2 className={style.numberMetricValue}>{value}</h2>
      </Card>
    )
  }

  mapDataForCharts(data: any[]) {
    const chartsData = data.map(metric => ({
      time: moment(metric.created_on)
        .startOf('day')
        .unix(),
      [metric.channel]: metric.value
    }))

    return _.sortBy(chartsData, 'time')
  }

  formatTick = timestamp => moment.unix(timestamp).format('DD-MM')

  renderTimeSeriesChart(name: string, data) {
    const seccondsIn24Hours = 86400
    const tickCount = (this.state.endDate - this.state.startDate) / seccondsIn24Hours

    return (
      <div className={style.chartMetric}>
        <h4 className={style.chartMetricName}>{name}</h4>
        <ResponsiveContainer>
          <AreaChart data={this.mapDataForCharts(data)}>
            <Tooltip labelFormatter={this.formatTick} />
            <XAxis dataKey="time" tickFormatter={this.formatTick} tickCount={tickCount} />
            <YAxis />
            <Area stackId={1} type="monotone" dataKey="web" stroke={colorWeb} fill={colorWeb} />
            <Area stackId={2} type="monotone" dataKey="messenger" stroke={colorMessenger} fill={colorMessenger} />
            <Area stackId={3} type="monotone" dataKey="slack" stroke={colorSlack} fill={colorSlack} />
            <Area stackId={4} type="monotone" dataKey="telegram" stroke={colorTelegram} fill={colorTelegram} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    )
  }
}
