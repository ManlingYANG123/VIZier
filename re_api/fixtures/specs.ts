/**
 * Grounded fixtures mirroring the prototype/v2 dashboard tiles.
 *
 * These reuse the v2 datasets (prototype/v2/src/app.js). The velocity and
 * status tiles carry the shared `department` dimension as a real data column
 * (aggregated for display via a Vega-Lite transform), so the cross-filter
 * detector has genuine structural evidence and the compute step produces real
 * per-department numbers rather than anything fabricated.
 */
import type { BoardMeta, SpecMap, VegaLiteSpec } from "../src/contracts.ts";

const DEPARTMENTS = ["Design", "Eng", "Research", "QA", "Ops"] as const;
const DEPT_SHARE: Record<string, number> = {
  Design: 0.18,
  Eng: 0.34,
  Research: 0.14,
  QA: 0.18,
  Ops: 0.16,
};
export const STATUS_ORDER = ["On Track", "At Risk", "Blocked", "Completed"];
const STATUS_RANGE = ["#2e7356", "#dc7900", "#f14242", "#95a5bd"];

const VELOCITY_MONTHS = [
  { month: "Jan", completed: 14, target: 18 },
  { month: "Feb", completed: 19, target: 18 },
  { month: "Mar", completed: 16, target: 20 },
  { month: "Apr", completed: 23, target: 20 },
  { month: "May", completed: 28, target: 22 },
  { month: "Jun", completed: 31, target: 25 },
  { month: "Jul", completed: 27, target: 25 },
];

export interface VelocityRow {
  department: string;
  month: string;
  completed: number;
  target: number;
}

export const velocityByDept: VelocityRow[] = [];
for (const dept of DEPARTMENTS) {
  for (const m of VELOCITY_MONTHS) {
    velocityByDept.push({
      department: dept,
      month: m.month,
      completed: Math.max(1, Math.round(m.completed * DEPT_SHARE[dept])),
      target: Math.max(1, Math.round(m.target * DEPT_SHARE[dept])),
    });
  }
}

export const statusByDept = [
  { department: "Design", status: "On Track", value: 2 },
  { department: "Design", status: "At Risk", value: 1 },
  { department: "Design", status: "Completed", value: 1 },
  { department: "Eng", status: "On Track", value: 5 },
  { department: "Eng", status: "At Risk", value: 2 },
  { department: "Eng", status: "Blocked", value: 1 },
  { department: "Eng", status: "Completed", value: 2 },
  { department: "Research", status: "On Track", value: 2 },
  { department: "Research", status: "At Risk", value: 1 },
  { department: "QA", status: "On Track", value: 1 },
  { department: "QA", status: "At Risk", value: 1 },
  { department: "QA", status: "Blocked", value: 1 },
  { department: "Ops", status: "On Track", value: 1 },
  { department: "Ops", status: "Blocked", value: 1 },
];

export const departmentTasks = [
  { department: "Design", tasks: 34 },
  { department: "Eng", tasks: 58 },
  { department: "Research", tasks: 21 },
  { department: "QA", tasks: 17 },
  { department: "Ops", tasks: 12 },
];

const commonConfig = {
  background: "white",
  config: {
    view: { stroke: null },
    axis: { domainColor: "#e2e8f0", gridColor: "#eef2f7", tickColor: "#e2e8f0", labelColor: "#64748b" },
    legend: { labelColor: "#475569" },
  },
};

function taskVelocitySpec(): VegaLiteSpec {
  return {
    ...commonConfig,
    title: "Task Velocity",
    width: 460,
    height: 200,
    data: { values: velocityByDept },
    transform: [
      {
        aggregate: [
          { op: "sum", field: "completed", as: "completed" },
          { op: "sum", field: "target", as: "target" },
        ],
        groupby: ["month"],
      },
      { fold: ["completed", "target"], as: ["series", "value"] },
    ],
    mark: { type: "line", point: false, strokeWidth: 2 },
    encoding: {
      x: { field: "month", type: "ordinal", sort: null },
      y: { field: "value", type: "quantitative" },
      color: {
        field: "series",
        type: "nominal",
        scale: { range: ["#1f3b64", "#aeb9ca"] },
        legend: { orient: "top-right" },
      },
    },
  };
}

function departmentTasksSpec(): VegaLiteSpec {
  return {
    ...commonConfig,
    title: "Tasks by Department",
    width: 460,
    height: 200,
    data: { values: departmentTasks },
    mark: { type: "bar", cornerRadiusEnd: 4, color: "#23446f" },
    encoding: {
      x: { field: "department", type: "nominal", sort: null },
      y: { field: "tasks", type: "quantitative" },
      tooltip: [{ field: "department" }, { field: "tasks" }],
    },
  };
}

function sprintBurndownSpec(): VegaLiteSpec {
  return {
    ...commonConfig,
    title: "Sprint Burndown",
    width: 460,
    height: 200,
    data: {
      values: [
        { week: "W1", remaining: 142 },
        { week: "W2", remaining: 118 },
        { week: "W3", remaining: 97 },
        { week: "W4", remaining: 81 },
        { week: "W5", remaining: 60 },
        { week: "W6", remaining: 44 },
        { week: "W7", remaining: 31 },
      ],
    },
    mark: { type: "line", point: { filled: true, size: 55 }, strokeWidth: 2.4, color: "#cc5f17" },
    encoding: {
      x: { field: "week", type: "ordinal", sort: null },
      y: { field: "remaining", type: "quantitative" },
      tooltip: [{ field: "week" }, { field: "remaining" }],
    },
  };
}

function projectStatusSpec(): VegaLiteSpec {
  return {
    ...commonConfig,
    title: "Project Status Distribution",
    width: 300,
    height: 200,
    data: { values: statusByDept },
    transform: [
      { aggregate: [{ op: "sum", field: "value", as: "value" }], groupby: ["status"] },
    ],
    mark: { type: "arc", innerRadius: 48, outerRadius: 82, padAngle: 0.025, cornerRadius: 2 },
    encoding: {
      theta: { field: "value", type: "quantitative" },
      color: {
        field: "status",
        type: "nominal",
        scale: { domain: STATUS_ORDER, range: STATUS_RANGE },
        legend: { orient: "right" },
      },
      tooltip: [{ field: "status" }, { field: "value" }],
    },
  };
}

/** The v2 dashboard as an addressable spec map (the engine's input). */
export function dashboardSpecMap(): SpecMap {
  return {
    "task-velocity": taskVelocitySpec(),
    "department-tasks": departmentTasksSpec(),
    "sprint-burndown": sprintBurndownSpec(),
    "project-status": projectStatusSpec(),
  };
}

/**
 * Board chrome mirroring the v2 dashboard's initial state: a generic heading, no
 * subtitle, no KPI row, and chart tiles that carry a title but no takeaway
 * subtitle. This grounds the visual/narrative detectors the same way the spec map
 * grounds the interaction detectors.
 */
export function dashboardBoard(): BoardMeta {
  return {
    title: "Workspace Overview",
    subtitle: "",
    hasKpis: false,
    tiles: [
      { id: "task-velocity", title: "Task Velocity", hasSubtitle: false },
      { id: "department-tasks", title: "Tasks by Department", hasSubtitle: false },
      { id: "sprint-burndown", title: "Sprint Burndown", hasSubtitle: false },
      { id: "project-status", title: "Project Status Distribution", hasSubtitle: false },
    ],
  };
}

/** Bounds the v2 frontend uses to draw finding boxes, keyed by tile id. */
export const tileBounds: Record<string, { x: number; y: number; w: number; h: number }> = {
  "task-velocity": { x: 28, y: 96, w: 508, h: 258 },
  "department-tasks": { x: 564, y: 96, w: 508, h: 258 },
  "sprint-burndown": { x: 28, y: 400, w: 508, h: 272 },
  "project-status": { x: 564, y: 400, w: 508, h: 272 },
};
