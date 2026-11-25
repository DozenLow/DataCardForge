// Function signature registry — the C++ projection of docs/architecture/port-semantics-v1.md.
//
// A signature is the *shape* of a function card: its N input ports, its K output ports and
// the parameters it accepts. Built-in functions register here today; a future plugin is
// just another implementation of an existing signature (never a second entry point — the
// "one capability, one entry" rule from the port-semantics spec).
//
// Invariants carried by this header (locked in port-semantics-v1):
//   - portId / outputId are the identity; position is display order only;
//   - K is fixed by the signature and never by the data;
//   - parameters live in `params`, separate from the dataflow graph.
#pragma once

#include <string>
#include <vector>

#include "json.h"

namespace dc {

struct SignaturePort {
  std::string portId;       // stable identity, never renamed
  std::string displayName;  // human label; free to change
  bool required = true;
};

struct SignatureOutput {
  std::string outputId;     // stable identity, never renamed
};

struct FunctionSignature {
  std::string id;           // "builtin:expression-columns" — stable, never reused
  int version = 1;          // bump when the semantics change, never mutate under one id
  std::string displayName;
  std::vector<SignaturePort> inputs;
  std::vector<SignatureOutput> outputs;
  // Ports and outputs are declared by `params` instead of by this table. Only
  // `builtin:python` sets it: a script card's ports and outputs cannot be known before the
  // user declares them, so inputs/outputs above are an EMPTY TEMPLATE and
  // params.portNames / params.outputs are the declaration. This is the explicit correction
  // to "K is fixed by the signature" → "K is fixed by the declaration", never by data —
  // docs/decisions/2026-11-15-python-script-card.md §三.
  //
  // Consequence for callers: port validation for such a signature is params validation
  // (signature.cpp's declaration is not a shape), and the node still gets exactly ONE
  // result matrix: output 0 is the display matrix, the remaining declared outputs live in
  // ComputeNode::extraOutputs (v1 output selector plan, decision §三).
  bool portsFromParams = false;
  // Whether a node evaluates at creation (the v2 behaviour every existing signature
  // keeps) or only when the client explicitly asks, via POST /api/nodes/{id}/compute.
  // "When does it run" is a property of the capability, not of one card: the client
  // reads it from /api/signatures (`compute: "auto" | "explicit"`) and renders a
  // compute action instead of assuming the numbers exist.
  bool explicitCompute = false;
  // Whether evaluating this signature spawns a child process (the script card's
  // interpreter). The scheduler reads this trait to route the run through the process
  // lane — a registry-wide cap on concurrent children — instead of branching on the card
  // kind: the next heavy capability declares the same trait and gets the same lane.
  bool childProcess = false;
};

// Registry lookups. The returned pointers are valid for the process lifetime.
const FunctionSignature* findSignature(const std::string& id);
std::vector<const FunctionSignature*> allSignatures();

// Well-known built-in ids.
extern const char* const kSigExpressionColumns;
extern const char* const kSigLinearRegression;
extern const char* const kSigSummary;
extern const char* const kSigPython;
extern const char* const kSigUnitConvert;
extern const char* const kSigChartAnalysis;
extern const char* const kSigChartFilter;

// The summary statistic catalog. Its ORDER is the output row order of `builtin:summary`,
// and its ids are stable identities — never renamed, never reused, the same rule as
// portId/outputId. `params.stats` selects a SUBSET of this catalog; it never reorders it
// (row identity must not depend on the order a user typed). Row count is data (like the
// column count of an expression table); K stays 1.
const std::vector<std::string>& summaryStatCatalog();

}  // namespace dc
