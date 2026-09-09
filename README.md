# USDM Private Invoice

This project is built on the Midnight Network.

A privacy-preserving invoice application: invoices are created and settled on
Midnight with **private amounts**, while the invoice identifier and lifecycle
status live on the public ledger. The application integrates **USDM** at the
application layer through the VIA cross-chain protocol, which maintains the
USDM stablecoin natively on Midnight Mainnet (chain ID `64364449`) and Midnight
Preview (chain ID `64364450`). On Midnight Preview, USDM is deployed at contract
address `471dfe55c866fdbc…` with token color `003bacd9a361ba0d…`.

## How it works

The contract `contracts/usdm-private-invoice.compact` keeps two public ledger
fields per invoice:

- `invoiceId` (`Opaque<"string">`) — the invoice identifier,
- `status` (`Uint<0..18446744073709551615>`) — lifecycle status.

Status mapping (guarded by on-chain assertions):

- `0` = UNINITIALISED (fresh contract, no invoice yet)
- `1` = PENDING (issued, awaiting settlement)
- `2` = PAID (settled; final)

Amounts (the micro-USDM values used when creating and settling an invoice) are
passed as circuit witnesses and **never appear on the ledger**, so invoice
amounts remain private.

Two state transitions are defined, each protected by a state-transition guard
that rejects invalid moves on-chain:

- `createInvoice(newInvoiceId, amountMicroUsd)` — discloses a new invoice id and
  marks the invoice PENDING. **Guard:** rejects if an invoice already exists
  (`assert status == 0`).
- `settleInvoice(paidMicroUsd)` — records that the invoice was paid (PAID).
  **Guard:** rejects unless the invoice is PENDING (`assert status == 1`), so a
  PENDING invoice cannot be settled twice and an UNINITIALISED or already-PAID
  invoice cannot be settled.

## Live deployment (Midnight Preview)

- Contract address: `0bfe50c2ffbf4d9d5f90bc6d26f558844da094624617d38c5159065a10bff21c`
- Deployer: `mn_addr_preview1mz8gv8zau2cer7phr8thcnnj6hq6xsr5cvr5dxy7mdz53papn5ys03g5mh`
- Deployed: `2026-09-09T07:29:51Z`

### Real on-chain interactions

#### Successful transitions

| Action | Transaction id | Block height |
| --- | --- | --- |
| `createInvoice("INV-0001", 50000000 micro-USDM)` → PENDING | `000e0ef33b2f7b418e9001ea74e79b586dce073fc8a9269aa45a34b7e80d2a7bae` | 786918 |
| `settleInvoice(50000000 micro-USDM)` → PAID | `0020f0718dc2cb731b26565006a23eae646e1ad2bd7f2080b1e69b925f9fb24786` | 786922 |

The public ledger state on the indexer after settlement reads back:

```
invoiceId: "INV-0001"
status:    PAID
```

#### Rejected transitions (guard enforcement)

Both invalid transitions were attempted on-chain against the deployed contract
and **rejected** by the contract's assertions (the on-chain proof failed, so no
transaction hash is produced — these are rejected contract calls, not
submitted transactions):

| Attempted action | Outcome | On-chain rejection |
| --- | --- | --- |
| `createInvoice("INV-0001", 50000000)` again (duplicate) | REJECTED | `failed assert: invoice already exists` |
| `settleInvoice(50000000)` again after PAID | REJECTED | `failed assert: invoice must be PENDING to settle` |

These rejections confirm the state-transition guards are enforced on-chain:
an invoice ID cannot be created twice, and a settled (PAID) invoice cannot be
settled again.

## Getting started

Requirements: Node.js >= 22, a Midnight test wallet funded on Preview.

```bash
npm install
npm run compile                                  # compile the Compact contract (needs the midnight compact CLI)
npm run deploy -- --network preview             # deploy a new contract instance
npm run interact -- --network preview           # create + settle an invoice on-chain and print the ledger state
npm run negative -- --network preview           # assert invalid transitions (duplicate create, settle-after-PAID) are rejected
npm run cli -- --network preview                # interactive CLI
npm run test:e2e -- --network preview           # verify the deployed contract exists and is reachable
```

The proof-server endpoint must be reachable (default `http://127.0.0.1:6300`),
either from a local proof server or a remote one configured in the code.

## Privacy architecture

- Invoice amounts are **witnesses in the ZK circuit** — never stored on-chain.
- Only the invoice id and status are public.
- A real transaction from `createInvoice` proves the circuit on-chain without
  revealing the invoice amount.

## USDM integration

USDM is not minted to the invoice contract directly — Midnight does not support
contract-to-contract calls. Instead the DApp references USDM at the application
layer via the VIA protocol, which runs USDM natively on the Midnight Network:

- https://developer.vialabs.tech/docs/examples/midnight/overview
- `@via-labs-tech/usdm-bridge` (public npm package, MIT)
- USDM client contracts compile with Compact `language_version >= 0.21.0`.

## Repository layout

```
contracts/usdm-private-invoice.compact   # Compact contract source
contracts/managed/usdm-private-invoice/  # compiled contract (manifest generated by the CLI)
src/deploy.ts                            # deployment runner
src/cli.ts                               # interactive CLI (create/settle/read/balance)
scripts/interact.ts                      # automated on-chain walkthrough (create + settle)
scripts/negative-tests.ts                # asserts invalid transitions are rejected on-chain
scripts/e2e-check.ts                     # sanity check against the live contract
```