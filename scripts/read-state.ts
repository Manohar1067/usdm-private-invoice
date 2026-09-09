/**
 * Read-only on-chain ledger state query for the deployed USDM Private Invoice
 * contract. Prints invoiceId and numeric status so CI can confirm the on-chain
 * state without mutating anything.
 *
 * Usage: npx tsx scripts/read-state.ts --network preview
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { resolveNetwork, getDeployment } from '../src/network';

// @ts-expect-error wallet sync requires WebSocket
globalThis.WebSocket = WebSocket;

const { network, config: networkConfig } = resolveNetwork();

async function main() {
  const deployment = getDeployment(network);
  if (!deployment) throw new Error(`No deploy on file for ${network}.`);
  console.log(`Contract: ${deployment.address}`);
  console.log(`Network:  ${network}\n`);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const contractPath = path.join(
    path.resolve(here, '..', 'contracts', 'managed', 'usdm-private-invoice'),
    'contract',
    'index.js',
  );
  if (!fs.existsSync(contractPath)) throw new Error('Compiled contract missing — run `npm run compile`.');
  const UsdmPrivateInvoice = await import(pathToFileURL(contractPath).href);

  const publicDataProvider = indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS);
  const onChain = await publicDataProvider.queryContractState(deployment.address);
  if (!onChain) throw new Error('queryContractState returned null');

  const ledgerState = UsdmPrivateInvoice.ledger(onChain.data);
  const invoiceId = Buffer.from(ledgerState.invoiceId).toString();
  const status = Number(ledgerState.status);
  const label = status === 0 ? 'UNINITIALISED' : status === 1 ? 'PENDING' : status === 2 ? 'PAID' : String(status);
  console.log(`invoiceId: "${invoiceId}"`);
  console.log(`status:    ${status} (${label})`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
