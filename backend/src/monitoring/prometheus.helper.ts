export function formatGauge(
  name: string,
  value: number,
  labels: Record<string, string> = {},
): string {
  const lbl = Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
  return `# TYPE ${name} gauge\n${name}{${lbl}} ${value}`;
}

export function formatCounter(name: string, value: number, help: string): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name} ${value}`;
}
