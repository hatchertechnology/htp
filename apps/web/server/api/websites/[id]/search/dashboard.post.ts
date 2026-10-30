import { proxySearch } from '../../../../utils/search'
export default defineEventHandler(event => proxySearch(event, 'dashboard'))
