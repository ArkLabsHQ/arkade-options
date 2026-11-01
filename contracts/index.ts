/**
 * Import surface for a desk, an order book, or a UI.
 *
 * The JSON files in this directory are the compiler artifacts. `vaultProgram`
 * and `beaconProgram` load them. `bindFill` takes an explicit holder and
 * writer. An announcement's program id defaults to OptionVault.
 */
import attestationBeaconArtifact from "./attestation_beacon.artifact.json" with { type: "json" };
import optionVaultArtifact from "./option_vault.artifact.json" with { type: "json" };

export { attestationBeaconArtifact, optionVaultArtifact };

export { OPTION_VAULT_PROGRAM_ID } from "../protocol/constants.ts";

export { beaconProgram, vaultProgram, vaultProgramFor } from "../protocol/programs.ts";

export { announceFill, parsePosition, type OptionPosition } from "../protocol/messages.ts";

export {
  bindContracts,
  bindFill,
  type Bound as OptionBound,
  type Terms,
  type VaultFill,
} from "../protocol/contracts.ts";

export {
  beaconIdOf,
  bindBeacon,
  type BeaconArgs,
  type BeaconId,
  type Bound as BeaconBound,
} from "../protocol/beacon.ts";

export { buildSettle, submit } from "../protocol/cospend.ts";

export { settlePayouts, slotFixing, slotPrice } from "../settle/vault.ts";
