/**
 * Negative transition tests against the deployed USDM Private Invoice
 * contract on Midnight Preview.
 *
 * The contract must already be PAID (invoice "INV-0001" exists). This script
 * attempts two INVALID transitions and asserts each is REJECTED on-chain:
 *   1. createInvoice("INV-0001", ...) again  → must be rejected (already exists)
 *   2. settleInvoice(...) again              → must be rejected (already PAID)
 *
 * Rejections may surface either as a failed on-chain proof (assertion) or as
 * a rejected contract call before submission. We capture and print the actual
 * error; we do NOT invent a transaction hash when none is produced.
 *
 * Exit code 0 only if both transitions are rejected as expected.
 *
 * Usage: npm run negative -- --network preview
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { resolveNetwork, getOrCreateWallet, getDeployment } from '../src/network';
import { createWallet, persistWalletState, unshieldedToken } from '../src/wallet';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';

// @ts-expect-error wallet sync requires WebSocket
globalThis.WebSocket = WebSocket;

const PRIVATE_STATE_ID = 'usdmPrivateInvoiceState';

const { network, config: networkConfig } = resolveNetwork();
const WALLET = getOrCreateWallet(network);
if (!WALLET.seed) throw new Error('No wallet on file for this network');

function fail(msg: string): never {
  console.error(`❌ negative-tests failed: ${msg}`);
  process.exit(1);
}

async function main() {
  const deployment = getDeployment(network);
  if (!deployment) fail(`No deploy on file for ${network}. Run \`npm run deploy -- --network ${network}\`.`);

  console.log(`Contract: ${deployment.address}`);
  console.log(`Network:  ${network}\n`);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const zkConfigPath = path.resolve(here, '..', 'contracts', 'managed', 'usdm-private-invoice');
  const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
  if (!fs.existsSync(contractPath)) fail('Compiled contract missing — run `npm run compile`.');
  const UsdmPrivateInvoice = await import(pathToFileURL(contractPath).href);
  const compiledContract = CompiledContract.make('usdm-private-invoice', UsdmPrivateInvoice.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(zkConfigPath),
  );

  const walletCtx = await createWallet({ network, networkConfig, seed: WALLET.seed });
  await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx);
  const dustBalance = (await walletCtx.wallet.waitForSyncedState()).dust.balance(new Date());
  console.log(`DUST: ${dustBalance.toLocaleString()}`);
  if (dustBalance === 0n) fail('No DUST available to pay tx fees.');

  const privateStatePassword = process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1';
  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const walletProvider = {
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return walletCtx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };
  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'usdm-private-invoice-state',
      accountId: walletCtx.unshieldedKeystore.getBech32Address().toString(),
      privateStoragePasswordProvider: () => privateStatePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };

  const onChain = await providers.publicDataProvider.queryContractState(deployment.address);
  if (!onChain) fail('queryContractState returned null');
  const ledgerState = UsdmPrivateInvoice.ledger(onChain.data);
  const existingId = Buffer.from(ledgerState.invoiceId).toString();
  const statusNum = ledgerState.status;
  console.log(`Pre-test ledger state: invoiceId="${existingId}" status=${statusNum}\n`);

  let rejected1 = false;
  let rejected2 = false;

  try {
    const deployed: any = await findDeployedContract(providers, {
      compiledContract: compiledContract as any,
      contractAddress: deployment.address,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: {},
    });
    console.log('Connected to contract.\n');

    // ---- Negative test 1: duplicate createInvoice ---------------------------
    // Must be REJECTED: the invoice ID already exists (status != 0).
    console.log(`── (NEG) createInvoice("${existingId}", 50000000) again (must be rejected) ...`);
    try {
      const tx = await deployed.callTx.createInvoice(existingId, 50000000n);
      console.log(`   ⚠ UNEXPECTED SUCCESS — was NOT rejected. txId=${tx.public.txId}`);
    } catch (err: any) {
      rejected1 = true;
      const msg = err?.message || err?.cause?.message || String(err);
      console.log(`   ✅ REJECTED. Error: ${msg.split('\n')[0]}`);
    }

    // ---- Negative test 2: settleInvoice after PAID --------------------------
    // Must be REJECTED: status != 1 (PENDING).
    console.log(`── (NEG) settleInvoice(50000000) again after PAID (must be rejected) ...`);
    try {
      const tx = await deployed.callTx.settleInvoice(50000000n);
      console.log(`   ⚠ UNEXPECTED SUCCESS — was NOT rejected. txId=${tx.public.txId}`);
    } catch (err: any) {
      rejected2 = true;
      const msg = err?.message || err?.cause?.message || String(err);
      console.log(`   ✅ REJECTED. Error: ${msg.split('\n')[0]}`);
    }

    await persistWalletState(network, walletCtx);
    await walletCtx.wallet.stop();

    console.log(`\nResult: createInvoice-duplicate rejected=${rejected1}; settle-after-PAID rejected=${rejected2}`);
    if (!rejected1 || !rejected2) {
      fail('Not all invalid transitions were rejected.');
    }
    console.log('negative-tests: PASS ✅ (both invalid transitions rejected)');
  } catch (err: any) {
    await walletCtx.wallet.stop();
    console.error(err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
