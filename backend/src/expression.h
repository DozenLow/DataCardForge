// Column expression engine — C++ port of web/src/core/expression.ts.
//
// Differential contract (docs/architecture/backend-protocol-v1.md): this file and the
// TS reference must agree on every case in web/tests/fixtures/xlayer/*.json, including
// error codes and positions. When changing one side, change the other and re-run both
// fixture runners. Semantics deliberately mirrored:
//   - identifiers resolve case-insensitively; "Pos.N" also registers under "N"
//   - aggregations reduce to a scalar then broadcast; NaN values are skipped
//   - MIN/MAX single-arg aggregate, multi-arg element-wise
//   - STD is Bessel-corrected (n-1); n<=1 yields 0
//   - comparison ops yield 1/0; division by zero follows IEEE (±Infinity)
//   - "^" right-associative; MOV window clamps at the edges; EMA seeds out[0]=data[0]
#pragma once

#include <cstdint>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace dc {

struct ExpressionError : std::runtime_error {
  std::string code;
  int64_t position = -1;
  // The thing the message names in quotes (offending character, column, function or
  // token). The message already embeds it, but a client that localises the error needs
  // the value as data — the UI printed a literal "{char}" for two months because only
  // `position` travelled over the wire.
  std::string detail;
  // badArgCount only: the declared arity (argMax = INT32_MAX for a variadic function) and
  // the arity the expression actually supplied.
  int64_t argMin = -1;
  int64_t argMax = -1;
  int64_t argGot = -1;
  ExpressionError(std::string message, int64_t pos, std::string code_)
      : std::runtime_error(std::move(message)), code(std::move(code_)), position(pos) {}
  ExpressionError(std::string message, int64_t pos, std::string code_, std::string detail_)
      : std::runtime_error(std::move(message)),
        code(std::move(code_)),
        position(pos),
        detail(std::move(detail_)) {}
};

/**
 * One input port's slice of the flat column list.
 *
 * A function card can bind several tables, so the expression needs a way to say *which*
 * table a column belongs to: `A.pos.1`, `A.温度`, `A.[地面速度_μm/s]`. The alias is the
 * port identity the card shows (its letter of the declaration order, or the port id), and
 * the range is where that port's columns live in `columnNames`.
 */
struct AliasRange {
  std::string alias;
  size_t first = 0;
  size_t count = 0;
};

// Forward declaration — full definition in matrix_value.h.
class MatVal;

class ExprEngine {
 public:
  // columnNames are matched case-insensitively ("Pos.N" additionally under "N"). Every
  // column also answers to its `Pos.N` name, its bare number, and its annotation, so an
  // annotated table is addressable by any of the spellings its card advertises. Doubly
  // bracketed `[名字]` binds a name verbatim (for names with `/`, spaces, parentheses).
  // Throws ExpressionError on any parse/compile failure (codes match the TS engine).
  static std::vector<double> evaluate(const std::string& expression,
                                      const std::vector<std::string>& columnNames,
                                      const std::vector<std::vector<double>>& columns,
                                      size_t length,
                                      const std::vector<AliasRange>& aliases = {});

  /**
   * The `+`/`-` conversions an `auto` unit policy performs, keyed by the INDEX of the pair in
   * the depth-first walk (the order must be the same on the TypeScript side).
   */
  struct UnitConversion {
    int64_t pair = -1;
    double factor = 0.0;
    std::string fromUnit;
    std::string toUnit;
  };

  /**
   * Auto-conversion input (units L2b). Present ⇒ the operator-level rewrite below may change
   * numbers; absent/nullptr ⇒ `evaluate()` behaves exactly as it always has.
   *
   * `columnUnits[i]` is the CONVERTIBLE unit of column i (a `units.h` candidate: non-empty
   * dimension, non-empty unit name), or empty for a column whose unit is not provable. The
   * engine never parses a header itself — the caller owns the resolution hierarchy and this
   * context only carries its answer.
   */
  struct AutoConvertContext {
    std::vector<std::string> columnUnits;
    std::vector<std::string> columnDimensions;
    std::vector<double> columnFactors;  // multiplier to the dimension's base unit
  };

  /**
   * Cell-mode evaluation with an optional auto-conversion policy.
   *
   * For EVERY `+`/`-` whose two operands are DIRECT column references, when both columns carry
   * a convertible unit of the SAME dimension but different units, the right operand is
   * converted to the left operand's unit (`value * factorRight / factorLeft`) before the
   * operator runs. Nothing else changes: nested or non-direct operands are never converted,
   * a cross-dimension pair is never converted (the warning path reports it instead), and
   * `policy != "auto"` takes the plain path without even looking at `context`.
   */
  struct AutoConvertRequest {
    std::string policy;
    AutoConvertContext context;
  };
  static std::vector<double> evaluateAuto(const std::string& expression,
                                          const std::vector<std::string>& columnNames,
                                          const std::vector<std::vector<double>>& columns,
                                          size_t length,
                                          const std::vector<AliasRange>& aliases,
                                          const AutoConvertRequest* request,
                                          std::vector<UnitConversion>* conversions = nullptr);

  /**
   * Matrix-mode evaluation. Each input is a full matrix (rows×cols). The formula uses
   * matrix semantics: `*` = matmul, TRANSPOSE/DET/INV/SOLVE available. Returns the
   * result as a flat column-major vector with shape written to outRows/outCols.
   *
   * @param matrixModeVars  Set of variable names that are matrix-mode (uppercase first
   *                        letter by convention, but explicitly declared in the port).
   * @throws ShapeError     Dimension mismatch in matrix ops.
   * @throws ExpressionError Parse/unknown-function errors (same codes as cell mode).
   */
  static std::vector<double> evaluateMatrix(
      const std::string& expression,
      const std::vector<std::string>& varNames,
      const std::vector<MatVal>& inputs,
      int64_t* outRows, int64_t* outCols);

  // Names actually referenced by the expression (original spelling, first occurrence),
  // matching CompiledExpression.references on the TS side.
  static std::vector<std::string> references(const std::string& expression,
                                             const std::vector<std::string>& columnNames);

  /**
   * Which flat column each operand of a unit-relevant operator refers to.
   *
   * A static-analysis view of the same AST `evaluate()` runs — it computes nothing and
   * changes nothing. One entry per `+`, `-`, comparison (`> < >= <= == !=`) and `IF`
   * argument; `leftColumn`/`rightColumn` are indices into `columnNames` and are -1 when
   * that operand is NOT a direct column reference (a number, a nested call, a sub
   * expression). Ambiguity is reported as -1 on purpose: a caller that wants to talk
   * about units must never guess which column a compound operand came from.
   *
   * Throws ExpressionError exactly like `evaluate()` for the same input, so a caller that
   * already computed the expression can call this afterwards and only ever see the same
   * (already reported) failure.
   */
  struct OperandPair {
    std::string op;  // the binary operator, or "IF" for an if-branch pair
    int64_t leftColumn = -1;
    int64_t rightColumn = -1;
    // `IF(cond, a, b)`: index 1 = the taken/else pair (a, b); 0 = the condition pair.
    // Binary operators always report 0.
    int64_t branch = 0;
  };
  static std::vector<OperandPair> operandPairs(const std::string& expression,
                                               const std::vector<std::string>& columnNames,
                                               const std::vector<AliasRange>& aliases = {});
};

}  // namespace dc
