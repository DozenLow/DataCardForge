/**
 * Card → protocol port bindings.
 *
 * This is the *only* place that turns a card's `inputs[]` into the bindings the compute
 * backend sees. Extracted from the store for two reasons:
 *
 *   1. it is the seam the card-layer fixtures referee (web/tests/fixtures/cards/): the same
 *      JSON must produce the same port list on both sides of the wire;
 *   2. `portId` is the identity the port-semantics spec locks in — spelling that rule once,
 *      in one function, is what keeps a second (positional) convention from reappearing.
 */
import type { PortBindingDto } from '../backend/client.ts';
import type { FunctionCardModel, PortConnection } from './types.ts';

/** Port id a function card uses for its matrix input (matches the signature declaration). */
export const SOURCE_PORT = 'src';

/** Port ids of `builtin:linear-regression` (declared by the signature, not by position). */
export const REGRESSION_PORT_X = 'x';
export const REGRESSION_PORT_Y = 'y';

/**
 * The name a port injects into the signature's own namespace.
 *
 * `portId` is the edge identity and never changes (`docs/architecture/port-semantics-v1.md`).
 * A signature whose parameters are user code may need a SECOND, human-chosen name for the
 * same port, because the name is what the parameters refer to. That declaration is
 * `params.portNames`, ordered like `inputs[]` — the same convention the backend validates on
 * the wire — so this rule needs to know no signature at all: a card that declares nothing
 * uses its port ids, which is what every signature did before the option existed.
 */
export function portVarName(
  card: FunctionCardModel,
  input: PortConnection,
  index: number,
): string {
  const declared: unknown = card.params.portNames;
  if (!Array.isArray(declared)) return input.portId;
  const name: unknown = declared[index];
  return typeof name === 'string' && name.length > 0 ? name : input.portId;
}

/**
 * Bindings for one function card, in the order the signature declares its ports.
 *
 * A card whose input matrix has no server id yet (offline, or not registered) yields
 * `null` — there is nothing authoritative to bind to, and inventing an id would bind the
 * node to a matrix the server does not have.
 */
export function portBindingsFor(
  card: FunctionCardModel,
  backendMatrixId: (localMatrixId: number) => number | null,
): PortBindingDto[] | null {
  const bindings: PortBindingDto[] = [];
  for (let index = 0; index < card.inputs.length; ++index) {
    const input = card.inputs[index];
    const serverId = backendMatrixId(input.target.matrixId);
    // A partially resolved card must bind NOTHING: the wire list is positional (the backend
    // matches `portNames[k]` to `inputs[k]`), so shipping three of four ports would shift
    // every name one slot instead of failing loudly.
    if (serverId === null) return null;
    // The target shape decides the wire mode: a table port takes the whole table, a cell
    // port takes exactly one column. `mode` used to be cosmetic (the backend always bound
    // the whole table), so keeping these in sync is what makes a column port honest.
    bindings.push(
      input.target.type === 'cell'
        ? {
            portId: input.portId,
            varName: portVarName(card, input, index),
            mode: 'cell',
            sourceMatrixId: serverId,
            columnIndex: input.target.column,
          }
        : {
            portId: input.portId,
            varName: portVarName(card, input, index),
            mode: 'matrix',
            sourceMatrixId: serverId,
          },
    );
  }
  return bindings;
}
