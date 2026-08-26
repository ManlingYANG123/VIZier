import test from "node:test";
import assert from "node:assert/strict";
import type { Proposal, VegaLiteSpec } from "../src/contracts.ts";
import {
  lowMaterialityTextAlignmentReason,
  lowMaterialityTextRewriteReason,
} from "../src/generate/materiality.ts";

const calloutSpec = {
  data: { values: [{ x: 0 }] },
  layer: [{
    mark: { type: "text", align: "center", dy: 18 },
    encoding: {
      text: { value: "House Sparrows have roughly halved\nsince the 1970s — yet they are still\nBritain's number-one garden bird." },
    },
  }],
} as unknown as VegaLiteSpec;

function alignmentProposal(): Proposal {
  return {
    kind: "edit-spec",
    mode: "executable",
    edits: [
      { op: "set", path: ["layer", 0, "mark", "align"], value: "left" },
      { op: "set", path: ["layer", 0, "mark", "dx"], value: -12 },
    ],
  };
}

function textProposal(value: string): Proposal {
  return {
    kind: "edit-spec",
    mode: "executable",
    edits: [{
      op: "set",
      path: ["layer", 0, "encoding", "text", "value"],
      value,
    }],
  };
}

test("an alignment-only alternative for a short infographic callout is not a material critique", () => {
  assert.match(lowMaterialityTextAlignmentReason({
    proposal: alignmentProposal(),
    spec: calloutSpec,
    dashboardType: "infographic",
  }) || "", /alternative style/);
});

test("an explicit author alignment request bypasses the materiality preference gate", () => {
  assert.equal(lowMaterialityTextAlignmentReason({
    proposal: alignmentProposal(),
    spec: calloutSpec,
    dashboardType: "infographic",
    explicitAuthorChange: true,
  }), null);
});

test("the gate does not suppress a substantive text transformation", () => {
  const proposal = alignmentProposal();
  proposal.edits!.push({
    op: "set",
    path: ["layer", 0, "encoding", "text", "value"],
    value: "A shorter takeaway.",
  });
  assert.equal(lowMaterialityTextAlignmentReason({
    proposal,
    spec: calloutSpec,
    dashboardType: "infographic",
  }), null);
});

test("a genuinely long body block may still receive an alignment critique", () => {
  const longSpec = structuredClone(calloutSpec) as unknown as {
    layer: Array<{ encoding: { text: { value: string } } }>;
  };
  longSpec.layer[0].encoding.text.value = Array.from({ length: 6 }, () =>
    "A long explanatory sentence that requires a stable reading edge.").join("\n");
  assert.equal(lowMaterialityTextAlignmentReason({
    proposal: alignmentProposal(),
    spec: longSpec as unknown as VegaLiteSpec,
    dashboardType: "infographic",
  }), null);
});

test("changing a truthful decade phrase to a year inside that decade is low-value microcopy", () => {
  assert.match(lowMaterialityTextRewriteReason({
    proposal: textProposal(
      "House Sparrows have roughly halved\nsince 1979 — yet they are still\nBritain's number-one garden bird.",
    ),
    spec: calloutSpec,
    dashboardType: "infographic",
  }) || "", /microcopy rewrite/);
});

test("an explicit author microcopy request bypasses the materiality gate", () => {
  assert.equal(lowMaterialityTextRewriteReason({
    proposal: textProposal(
      "House Sparrows have roughly halved\nsince 1979 — yet they are still\nBritain's number-one garden bird.",
    ),
    spec: calloutSpec,
    dashboardType: "infographic",
    explicitAuthorChange: true,
  }), null);
});

test("a directional correction is not suppressed as microcopy", () => {
  const directionalSpec = structuredClone(calloutSpec) as unknown as {
    layer: Array<{ encoding: { text: { value: string } } }>;
  };
  directionalSpec.layer[0].encoding.text.value = "The population increased since 1979.";
  assert.equal(lowMaterialityTextRewriteReason({
    proposal: textProposal("The population decreased since 1979."),
    spec: directionalSpec as unknown as VegaLiteSpec,
    dashboardType: "infographic",
  }), null);
});

test("a materially different numeric claim is not suppressed as microcopy", () => {
  const numericSpec = structuredClone(calloutSpec) as unknown as {
    layer: Array<{ encoding: { text: { value: string } } }>;
  };
  numericSpec.layer[0].encoding.text.value = "The population declined by 50% since 1979.";
  assert.equal(lowMaterialityTextRewriteReason({
    proposal: textProposal("The population declined by 40% since 1979."),
    spec: numericSpec as unknown as VegaLiteSpec,
    dashboardType: "infographic",
  }), null);
});
