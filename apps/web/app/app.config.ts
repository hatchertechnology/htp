export default defineAppConfig({
  ui: {
    colors: { primary: 'emerald', neutral: 'slate' },
    button: { slots: { base: 'cursor-pointer font-semibold rounded-lg', trailingIcon: 'size-4', leadingIcon: 'size-4' } },
    input: { slots: { base: 'rounded-lg', root: 'w-full' } },
  },
})
