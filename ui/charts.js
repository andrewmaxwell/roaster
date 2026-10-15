// The roast charts: three stacked plots sharing one time axis and one cursor,
// instead of one plot with two y-axes:
//   temperatures (BT, ET, and the reference roast's BT, dashed)
//   rate of rise (BT, °C/min)
//   controls (burner and air, %)
// Event markers (TP, FC, drop, steps) are vertical lines across all three;
// upcoming steps and the drop temperature are horizontal guides on the
// temperature plot.

import uPlot from './vendor/uPlot.esm.js';

const css = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// x is seconds; shown as m:ss (negative before charge).
const mmss = (s) => {
  const sign = s < 0 ? '-' : '';
  s = Math.abs(Math.round(s));
  return `${sign}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmt = (d, unit) => (u, v) => (v == null ? '–' : `${v.toFixed(d)}${unit}`);

export function createCharts(el) {
  const ink = {
    text: css('--text-secondary'),
    muted: css('--text-muted'),
    grid: css('--grid'),
    axis: css('--axis'),
    surface: css('--surface'),
  };
  const series = {
    BT: css('--series-1'),
    ET: css('--series-2'),
    burner: css('--series-3'),
    air: css('--series-4'),
  };
  let overlay = {markers: [], guides: [], pops: []};
  let xRange = [0, 600];

  const axis = (label, values) => ({
    label,
    labelSize: 18,
    labelFont: '12px system-ui',
    font: '11px system-ui',
    stroke: ink.muted,
    grid: {stroke: ink.grid, width: 1},
    ticks: {stroke: ink.axis, width: 1, size: 4},
    values,
    size: 46,
  });
  const xAxis = (show) => ({
    ...axis('', (u, vals) => vals.map(mmss)),
    show,
    size: show ? 34 : 0,
  });

  // Vertical event markers on every plot; labels only on the top one.
  const drawMarkers = (labels) => (u) => {
    const {ctx, bbox} = u;
    ctx.save();
    ctx.font = `${11 * devicePixelRatio}px system-ui`;
    const line = 13 * devicePixelRatio;
    const rowEnds = []; // right edge of the last label on each text row
    for (const m of overlay.markers) {
      const x = u.valToPos(m.x, 'x', true);
      if (x < bbox.left || x > bbox.left + bbox.width) continue;
      ctx.strokeStyle = m.strong ? ink.text : ink.axis;
      ctx.setLineDash(
        m.strong ? [] : [3 * devicePixelRatio, 3 * devicePixelRatio],
      );
      ctx.lineWidth = devicePixelRatio;
      ctx.beginPath();
      ctx.moveTo(x, bbox.top);
      ctx.lineTo(x, bbox.top + bbox.height);
      ctx.stroke();
      if (labels && m.label) {
        // Markers close together (FC right after a step) would print their
        // labels on top of each other: use the first row that has room.
        const left = x + 3 * devicePixelRatio;
        let row = rowEnds.findIndex((end) => end < left);
        if (row < 0) row = rowEnds.length;
        rowEnds[row] = left + ctx.measureText(m.label).width + 4;
        ctx.fillStyle = m.strong ? ink.text : ink.muted;
        ctx.fillText(
          m.label,
          left,
          bbox.top + 12 * devicePixelRatio + row * line,
        );
      }
    }
    ctx.restore();
  };

  // Horizontal guides (next steps, drop temp) and pop ticks on the top plot.
  const drawGuides = (u) => {
    const {ctx, bbox} = u;
    ctx.save();
    ctx.font = `${11 * devicePixelRatio}px system-ui`;
    ctx.textAlign = 'right';
    for (const g of overlay.guides) {
      const y = u.valToPos(g.y, 'y', true);
      if (y < bbox.top || y > bbox.top + bbox.height) continue;
      ctx.strokeStyle = g.strong ? ink.text : ink.axis;
      ctx.setLineDash([2 * devicePixelRatio, 4 * devicePixelRatio]);
      ctx.lineWidth = devicePixelRatio;
      ctx.beginPath();
      ctx.moveTo(bbox.left, y);
      ctx.lineTo(bbox.left + bbox.width, y);
      ctx.stroke();
      ctx.fillStyle = g.strong ? ink.text : ink.muted;
      ctx.fillText(
        g.label,
        bbox.left + bbox.width - 4,
        y - 4 * devicePixelRatio,
      );
    }
    ctx.fillStyle = ink.text;
    for (const t of overlay.pops) {
      const x = u.valToPos(t, 'x', true);
      if (x < bbox.left || x > bbox.left + bbox.width) continue;
      ctx.fillRect(
        x - devicePixelRatio,
        bbox.top + bbox.height - 10 * devicePixelRatio,
        2 * devicePixelRatio,
        8 * devicePixelRatio,
      );
    }
    ctx.restore();
  };

  const common = (height, showX) => ({
    width: el.clientWidth,
    height,
    // The same padding everywhere, so a time lines up across all three plots
    // (uPlot otherwise pads only the bottom one for its x labels).
    padding: [8, 20, 0, 0],
    cursor: {sync: {key: 'roast'}, drag: {x: false, y: false}},
    scales: {x: {time: false, range: () => xRange}},
    legend: {live: true},
    axes: [xAxis(showX), null],
  });

  const h = el.clientHeight || 600;
  const temp = new uPlot(
    {
      ...common(Math.round(h * 0.56), false),
      scales: {
        x: {time: false, range: () => xRange},
        y: {
          range: (u, min, max) => [
            Math.min(50, min ?? 50),
            Math.max(230, max ?? 230),
          ],
        },
      },
      series: [
        {label: 'time', value: (u, v) => (v == null ? '–' : mmss(v))},
        {
          label: 'BT',
          stroke: series.BT,
          width: 2,
          value: fmt(1, '°'),
          spanGaps: true,
        },
        {
          label: 'ET',
          stroke: series.ET,
          width: 2,
          value: fmt(1, '°'),
          spanGaps: true,
        },
        {
          label: 'reference BT',
          stroke: ink.muted,
          width: 1.5,
          dash: [6, 4],
          value: fmt(1, '°'),
          spanGaps: true,
        },
      ],
      axes: [xAxis(false), axis('°C')],
      hooks: {draw: [drawGuides, drawMarkers(true)]},
    },
    [[], [], [], []],
    el,
  );
  const ror = new uPlot(
    {
      ...common(Math.round(h * 0.22), false),
      scales: {
        x: {time: false, range: () => xRange},
        // 0-25 covers a roast; widen for a fast preheat or the fall
        // after a drop rather than clipping the line.
        y: {
          range: (u, min, max) => [
            Math.max(-30, Math.min(0, min ?? 0)),
            Math.min(60, Math.max(25, max ?? 25)),
          ],
        },
      },
      series: [
        {label: 'time', value: (u, v) => (v == null ? '–' : mmss(v))},
        {
          label: 'BT rate of rise',
          stroke: series.BT,
          width: 2,
          value: fmt(1, '°/min'),
        },
      ],
      axes: [xAxis(false), axis('°C/min')],
      hooks: {draw: [drawMarkers(false)]},
    },
    [[], []],
    el,
  );
  const controls = new uPlot(
    {
      ...common(Math.round(h * 0.22), true),
      scales: {
        x: {time: false, range: () => xRange},
        y: {range: () => [0, 100]},
      },
      series: [
        {label: 'time', value: (u, v) => (v == null ? '–' : mmss(v))},
        {
          label: 'burner',
          stroke: series.burner,
          width: 2,
          paths: uPlot.paths.stepped({align: 1}),
          value: fmt(0, '%'),
        },
        {
          label: 'air',
          stroke: series.air,
          width: 2,
          paths: uPlot.paths.stepped({align: 1}),
          value: fmt(0, '%'),
        },
      ],
      axes: [xAxis(true), axis('%')],
      hooks: {draw: [drawMarkers(false)]},
    },
    [[], [], []],
    el,
  );
  const plots = [temp, ror, controls];

  const api = {
    // d: {x, BT, ET, ror, HP, FC} (aligned), ref: {x, BT} or null
    update(d, ref, range, over) {
      xRange = range;
      overlay = over;
      const live = [d.x, d.BT, d.ET];
      const data = ref
        ? uPlot.join([live, [ref.x, ref.BT]])
        : [...live, d.x.map(() => null)];
      temp.setData(data);
      ror.setData([d.x, d.ror]);
      controls.setData([d.x, d.HP, d.FC]);
    },
    // Fit all three plots, legends included, into the container.
    resize() {
      const legends = plots.reduce(
        (sum, p) =>
          sum + (p.root.querySelector('.u-legend')?.offsetHeight ?? 0),
        0,
      );
      const avail = Math.max(300, (el.clientHeight || 600) - legends - 12);
      const w = el.clientWidth;
      temp.setSize({width: w, height: Math.round(avail * 0.56)});
      ror.setSize({width: w, height: Math.round(avail * 0.22)});
      controls.setSize({width: w, height: Math.round(avail * 0.22)});
    },
    destroy() {
      observer.disconnect();
      plots.forEach((p) => p.destroy());
    },
  };
  // The container settles its size after layout (and on window resizes).
  const observer = new ResizeObserver(() => api.resize());
  observer.observe(el);
  return api;
}
