/**
 * Automated on-chain interaction with the deployed USDM Private Invoice
 * contract on Midnight Preview.
 *
 * Performs a real, non-interactive walkthrough:
 *   1. createInvoice("INV-0001", <private amount>)   → PENDING
 *   2. settleInvoice(<paid amount>)                  → PAID
 *   3. reads the public ledger state back from the indexer
 *
 * Prints real transaction IDs / block heights for the README and report.
 *
 * Usage: npm run interact -- --network preview
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
  console.error(`❌ interact failed: ${msg}`);
  process.exit(1);
}

async function main() {
  const deployment = getDeployment(network);
  if (!deployment) fail(`No deploy on file for ${network}. Run \`npm run deploy -- --network ${network}\`.`);

  console.log(`Contract: ${deployment.address}`);
  console.log(`Network:  ${network}\n`);

  // Compiled contract
  const here = path.dirname(fileURLToPath(import.meta.url));
  const zkConfigPath = path.resolve(here, '..', 'contracts', 'managed', 'usdm-private-invoice');
  const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
  if (!fs.existsSync(contractPath)) fail('Compiled contract missing — run `npm run compile`.');
  const UsdmPrivateInvoice = await import(pathToFileURL(contractPath).href);
  const compiledContract = CompiledContract.make('usdm-private-invoice', UsdmPrivateInvoice.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(zkConfigPath),
  );

  // Wallet
  const walletCtx = await createWallet({ network, networkConfig, seed: WALLET.seed });
  const state = await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx);
  const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
  const dustBalance = state.dust.balance(new Date());
  console.log(`tNight balance: ${balance.toLocaleString()} | DUST: ${dustBalance.toLocaleString()}`);
  if (dustBalance === 0n) fail('No DUST available to pay tx fees — fund NIGHT from the faucet and retry.');

  // Providers
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

  // Reconnect to the deployed contract
  const deployed: any = await findDeployedContract(providers, {
    compiledContract: compiledContract as any,
    contractAddress: deployment.address,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: {},
  });
  console.log('Connected to contract.\n');

  // ---- 1. Create invoice ---------------------------------------------------
  const invoiceId = process.env.INVOICE_ID?.trim() || 'INV-0001';
  const amountMicroUsd = BigInt(process.env.INVOICE_AMOUNT_MICRO_USD?.trim() || '50000000');
  console.log(`── Creating invoice "${invoiceId}" (private amount ${amountMicroUsd} micro-USDM) ...`);
  const createTx = await deployed.callTx.createInvoice(invoiceId, amountMicroUsd);
  console.log(`✅ Invoice created — status PENDING`);
  console.log(`   txId: ${createTx.public.txId}`);
  console.log(`   blockHeight: ${createTx.public.blockHeight}\n`);

  // ---- 2. Settle invoice ---------------------------------------------------
  const paidMicroUsd = BigInt(process.env.INVOICE_SETTLED_MICRO_USD?.trim() || '50000000');
  console.log(`── Settling invoice (private paid amount ${paidMicroUsd} micro-USDM) ...`);
  const settleTx = await deployed.callTx.settleInvoice(paidMicroUsd);
  console.log(`✅ Invoice settled — status PAID`);
  console.log(`   txId: ${settleTx.public.txId}`);
  console.log(`   blockHeight: ${settleTx.public.blockHeight}\n`);

  // ---- 3. Read public ledger state back from the indexer -------------------
  const onChain = await providers.publicDataProvider.queryContractState(deployment.address);
  if (!onChain) fail('queryContractState returned null');
  const ledgerState = UsdmPrivateInvoice.ledger(onChain.data);
  const onChainId = Buffer.from(ledgerState.invoiceId).toString();
  const onChainStatus = ledgerState.status === 0x0n ? 'PENDING' : ledgerState.status === 0x1n ? 'PAID' : String(ledgerState.status);
  console.log('Public ledger state (read from indexer):');
  console.log(`   invoiceId: "${onChainId}"`);
  console.log(`   status:    ${onChainStatus}\n`);

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
  console.log('interact: complete. ✅');
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});