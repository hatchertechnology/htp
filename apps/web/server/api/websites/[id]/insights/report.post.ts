import { proxyInsight } from '../../../../utils/insights'
export default defineEventHandler(event => proxyInsight(event, 'insights/report'))
