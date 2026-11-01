import { proxyRepository } from '../../../../utils/repository'
export default defineEventHandler(event => proxyRepository(event, 'issues'))
