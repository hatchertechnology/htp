import { afterEach, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, ref, watch } from 'vue'
import { useConnectionReload } from '../app/composables/useConnectionReload'

afterEach(() => vi.unstubAllGlobals())
it.each(['Google Search', 'Bing'])('%s dashboard retries pending saved reads after connection transitions', async () => {
  vi.stubGlobal('watch', watch)
  const connected = ref(false), reauthorizationRequired = ref(false)
  const requests = vi.fn(() => connected.value ? 'saved partial report' : 'pending')
  const root = { children: [] as unknown[] }
  const renderer = createRenderer<any, any>({
    createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text },
    parentNode: () => null, nextSibling: () => null, patchProp: () => {}, remove: () => {},
    insert: (node, parent) => { parent.children.push(node) },
  })
  const component = defineComponent({ setup() {
    useConnectionReload(() => ['owner', 'site', connected.value, reauthorizationRequired.value], requests)
    return () => h('div', 'mocked authenticated dashboard')
  } })
  const app = renderer.createApp(component); app.mount(root)
  expect(requests).toHaveBeenCalledTimes(1)
  connected.value = true; await nextTick(); expect(requests).toHaveBeenCalledTimes(2)
  reauthorizationRequired.value = true; await nextTick(); expect(requests).toHaveBeenCalledTimes(3)
  reauthorizationRequired.value = false; await nextTick(); expect(requests).toHaveBeenCalledTimes(4)
  app.unmount()
})
