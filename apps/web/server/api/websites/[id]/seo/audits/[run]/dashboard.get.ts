import { streamSavedDetail } from '../../../../../../utils/saved-detail-stream'
export default defineEventHandler(event => streamSavedDetail(event))
