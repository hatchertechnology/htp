import { proxySeosmith } from '../../../../../utils/seosmith'
export default defineEventHandler(event => proxySeosmith(event, 'url-lifecycle'))
