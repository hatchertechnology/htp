const apiBaseUrl = 'https://htp-api-kerry-hatcher.fly.dev'

export default defineNuxtConfig({
  compatibilityDate: '2026-10-28',
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  devtools: { enabled: false },
  ui: { fonts: false, colorMode: false },
  icon: { clientBundle: { scan: true }, serverBundle: { collections: ['lucide'] } },
  runtimeConfig: {
    apiBaseUrl,
    appOrigin: 'http://localhost:3001',
    googleClientId: '',
    googleClientSecret: '',
    googleCookieKey: '',
    bingClientId: '',
    bingClientSecret: '',
    bingCookieKey: '',
    supabaseServiceRoleKey: '',
    public: {
      pagePerformanceSamples: false,
      apiBaseUrl,
      supabaseUrl: 'https://raxuvdbdfmmtpqjcafcq.supabase.co',
      // Publishable client key; never a service-role key or signing secret.
      supabasePublishableKey: 'sb_publishable_Loul540Y3Oj_qIojV0kr0w_Jq5vhn5H',
    },
  },
  app: {
    head: {
      title: 'Hatch · Website performance',
      htmlAttrs: { lang: 'en', class: 'light' },
      meta: [{ name: 'description', content: 'Your websites, their performance, and a clearer view of what comes next.' }],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },
  routeRules: {
    '/oauth/**': { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' } },
    '/auth/**': { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
    '/api/**': { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } },
    '/**': { headers: { 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' } },
  },
})
