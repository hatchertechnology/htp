import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
export default defineConfig({root:fileURLToPath(new URL('../../',import.meta.url)),plugins:[vue()],resolve:{alias:{'#shared':fileURLToPath(new URL('../../shared',import.meta.url))}},server:{host:'127.0.0.1',port:Number(process.env.BING_FIXTURE_PORT || 4177),strictPort:true}})
