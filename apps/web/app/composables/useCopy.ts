export function useCopy() {
  const toast = useToast()
  return async (value: string, label = 'Copied to clipboard') => {
    try {
      await navigator.clipboard.writeText(value)
      toast.add({ title: label, icon: 'i-lucide-check', color: 'success' })
    } catch {
      toast.add({ title: 'Could not copy', description: 'Select the text and copy it manually.', color: 'error' })
    }
  }
}
