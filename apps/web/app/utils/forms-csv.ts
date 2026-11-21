export function csvCell(value: unknown) { const text=String(value ?? ''); return `"${(/^[\s\x00-\x1f]*[=+@-]/.test(text) ? "'" : '') + text.replaceAll('"','""')}"` }
