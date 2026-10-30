import { proxyWebsites } from '../../utils/websites'
export default defineEventHandler(event => proxyWebsites(event))
