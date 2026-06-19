import { Injectable } from '@nestjs/common';

interface Counter {
  name: string;
  value: number;
  labels: Record<string, string>;
}

@Injectable()
export class MetricsService {
  private counters = new Map<string, Counter>();

  increment(name: string, labels: Record<string, string> = {}) {
    const key = `${name}:${JSON.stringify(labels)}`;
    const existing = this.counters.get(key);
    if (existing) {
      existing.value++;
    } else {
      this.counters.set(key, { name, value: 1, labels });
    }
  }

  getAll(): Counter[] {
    return [...this.counters.values()];
  }

  toPrometheus(): string {
    return this.getAll()
      .map(c => {
        const lbl = Object.entries(c.labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(',');
        return `${c.name}{${lbl}} ${c.value}`;
      })
      .join('\n');
  }
}
