import { proxySeosmithWork } from '../../../../../../utils/seosmith-work'
export default defineEventHandler(event => proxySeosmithWork(event, 'list'))
