/**
 * B4: In-process Prometheus metrics registry.
 *
 * Zero-dep. Hand-rolled exposition format per
 * https://prometheus.io/docs/instrumenting/exposition_formats/
 *
 * Supports counter, gauge, histogram (fixed buckets). Cardinality discipline
 * is the caller's responsibility — keep label values bounded.
 */

type LabelSet = Record<string, string | number>;

interface CounterSeries { value: number; labels: LabelSet }
interface GaugeSeries { value: number; labels: LabelSet }

const HTTP_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface HistogramSeries {
  bucketCounts: number[];
  sum: number;
  count: number;
  labels: LabelSet;
}

interface MetricDef {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
}

const defs = new Map<string, MetricDef>();
const counters = new Map<string, Map<string, CounterSeries>>();
const gauges = new Map<string, Map<string, GaugeSeries>>();
const histograms = new Map<string, Map<string, HistogramSeries>>();

function ensureDef(name: string, help: string, type: MetricDef['type']) {
  const existing = defs.get(name);
  if (existing) {
    if (existing.type !== type) {
      throw new Error(`metric ${name} already registered as ${existing.type}, not ${type}`);
    }
    return;
  }
  defs.set(name, { name, help, type });
}

function seriesKey(labels: LabelSet): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${String(labels[k])}`).join(',');
}

function fmtLabels(labels: LabelSet): string {
  const keys = Object.keys(labels).sort();
  if (!keys.length) return '';
  const pairs = keys.map((k) => {
    const v = String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    return `${k}="${v}"`;
  });
  return `{${pairs.join(',')}}`;
}

export function counter(name: string, help: string) {
  ensureDef(name, help, 'counter');
  if (!counters.has(name)) counters.set(name, new Map());
  const series = counters.get(name)!;
  return {
    inc(labels: LabelSet = {}, delta = 1) {
      const k = seriesKey(labels);
      const cur = series.get(k);
      if (cur) cur.value += delta;
      else series.set(k, { value: delta, labels });
    },
  };
}

export function gauge(name: string, help: string) {
  ensureDef(name, help, 'gauge');
  if (!gauges.has(name)) gauges.set(name, new Map());
  const series = gauges.get(name)!;
  return {
    set(value: number, labels: LabelSet = {}) {
      series.set(seriesKey(labels), { value, labels });
    },
    inc(labels: LabelSet = {}, delta = 1) {
      const k = seriesKey(labels);
      const cur = series.get(k);
      if (cur) cur.value += delta;
      else series.set(k, { value: delta, labels });
    },
    dec(labels: LabelSet = {}, delta = 1) {
      const k = seriesKey(labels);
      const cur = series.get(k);
      if (cur) cur.value -= delta;
      else series.set(k, { value: -delta, labels });
    },
  };
}

export function histogram(name: string, help: string) {
  ensureDef(name, help, 'histogram');
  if (!histograms.has(name)) histograms.set(name, new Map());
  const series = histograms.get(name)!;
  return {
    observe(valueSeconds: number, labels: LabelSet = {}) {
      const k = seriesKey(labels);
      let cur = series.get(k);
      if (!cur) {
        cur = {
          bucketCounts: new Array(HTTP_BUCKETS_SECONDS.length).fill(0),
          sum: 0,
          count: 0,
          labels,
        };
        series.set(k, cur);
      }
      cur.sum += valueSeconds;
      cur.count += 1;
      for (let i = 0; i < HTTP_BUCKETS_SECONDS.length; i++) {
        if (valueSeconds <= HTTP_BUCKETS_SECONDS[i]) cur.bucketCounts[i] += 1;
      }
    },
  };
}

export const wsConnections = gauge(
  'remo_ws_connections',
  'Active WebSocket connections by role (client|agent).',
);

export const scheduledQueueDepth = gauge(
  'remo_scheduled_queue_depth',
  'In-flight scheduler run contexts being dispatched.',
);

export const sessionRunsInFlight = gauge(
  'remo_session_runs_in_flight',
  'Open session_runs across all supervisors (ended_at IS NULL).',
);

export const costCapUtilization = gauge(
  'remo_cost_cap_utilization',
  'Ratio of users whose daily cost cap was hit today (0..1).',
);

export const errorIntakeTotal = counter(
  'remo_error_intake_total',
  'Sentry-style error intake events by terminal result.',
);

export const httpRequestDuration = histogram(
  'remo_http_request_duration_seconds',
  'HTTP request handling latency in seconds, bucketed.',
);

export function renderPrometheus(): string {
  const out: string[] = [];
  for (const [name, def] of defs) {
    out.push(`# HELP ${name} ${def.help}`);
    out.push(`# TYPE ${name} ${def.type}`);
    if (def.type === 'counter') {
      const series = counters.get(name);
      if (series && series.size > 0) {
        for (const s of series.values()) {
          out.push(`${name}${fmtLabels(s.labels)} ${s.value}`);
        }
      } else {
        out.push(`${name} 0`);
      }
    } else if (def.type === 'gauge') {
      const series = gauges.get(name);
      if (series && series.size > 0) {
        for (const s of series.values()) {
          out.push(`${name}${fmtLabels(s.labels)} ${s.value}`);
        }
      } else {
        out.push(`${name} 0`);
      }
    } else if (def.type === 'histogram') {
      const series = histograms.get(name);
      if (series) {
        for (const s of series.values()) {
          for (let i = 0; i < HTTP_BUCKETS_SECONDS.length; i++) {
            const labels = { ...s.labels, le: String(HTTP_BUCKETS_SECONDS[i]) };
            out.push(`${name}_bucket${fmtLabels(labels)} ${s.bucketCounts[i]}`);
          }
          const infLabels = { ...s.labels, le: '+Inf' };
          out.push(`${name}_bucket${fmtLabels(infLabels)} ${s.count}`);
          out.push(`${name}_sum${fmtLabels(s.labels)} ${s.sum}`);
          out.push(`${name}_count${fmtLabels(s.labels)} ${s.count}`);
        }
      }
    }
  }
  return out.join('\n') + '\n';
}
