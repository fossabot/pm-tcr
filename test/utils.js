/* eslint-env mocha */
/* global artifacts */

const Eth = require('ethjs');
const HttpProvider = require('ethjs-provider-http');
const EthRPC = require('ethjs-rpc');
const abi = require('ethereumjs-abi');
const fs = require('fs');

const ethRPC = new EthRPC(new HttpProvider('http://localhost:7545'));
const ethQuery = new Eth(new HttpProvider('http://localhost:7545'));

const PLCRVoting = artifacts.require('PLCRVoting.sol');
const Parameterizer = artifacts.require('Parameterizer.sol');
const Registry = artifacts.require('Registry.sol');
const Token = artifacts.require('EIP20.sol');
const Bank = artifacts.require('Bank.sol');

const RegistryFactory = artifacts.require('RegistryFactory.sol');

const config = JSON.parse(fs.readFileSync('./conf/config.json'));
const paramConfig = config.paramDefaults;

const BN = small => new Eth.BN(small.toString(10), 10);

const utils = {
  // from: https://github.com/gnosis/safe-contracts/blob/master/test/utils.js
  logGasUsage: (subject, transactionOrReceipt) => {
    let receipt = transactionOrReceipt.receipt || transactionOrReceipt;
    console.log(`Gas costs for ${subject}:`);
    console.log(`    ${receipt.gasUsed}`);
  },

  logEvents: (subject, receipt) => {
    console.log(`Events for ${subject}:`);
    receipt.logs.forEach(log => {
      console.log(`    ${log.event}: ${JSON.stringify(log.args)}`);
    });
  },

  getProxies: async () => {
    const registryFactory = await RegistryFactory.deployed();
    const registryReceipt = await registryFactory.newRegistryWithToken(
      config.token.supply,
      config.token.name,
      config.token.decimals,
      config.token.symbol,
      [
        paramConfig.minDeposit,
        paramConfig.pMinDeposit,
        paramConfig.applyStageLength,
        paramConfig.pApplyStageLength,
        paramConfig.commitStageLength,
        paramConfig.pCommitStageLength,
        paramConfig.revealStageLength,
        paramConfig.pRevealStageLength,
        paramConfig.dispensationPct,
        paramConfig.pDispensationPct,
        paramConfig.voteQuorum,
        paramConfig.pVoteQuorum,
      ],
      'The TestChain Registry',
    );

    const {
      token,
      plcr,
      parameterizer,
      registry,
    } = registryReceipt.logs[0].args;

    const tokenInstance = Token.at(token);
    const votingProxy = PLCRVoting.at(plcr);
    const paramProxy = Parameterizer.at(parameterizer);
    const registryProxy = Registry.at(registry);

    // transfer 1/2 of the totalSupply
    const bankReserve = (await tokenInstance.totalSupply.call()).div('2');
    const bankAddress = await registryProxy.bank.call();
    const bankInstance = Bank.at(bankAddress);
    await tokenInstance.transfer(bankAddress, bankReserve);

    const proxies = {
      tokenInstance,
      votingProxy,
      paramProxy,
      registryProxy,
      bankInstance,
    };
    return proxies;
  },

  approveProxies: async (accounts, token, plcr, parameterizer, registry) => (
    Promise.all(accounts.map(async (user) => {
      await token.transfer(user, 1000000000000000);
      if (plcr) {
        await token.approve(plcr.address, 1000000000000000, { from: user });
      }
      if (parameterizer) {
        await token.approve(parameterizer.address, 1000000000000000, { from: user });
      }
      if (registry) {
        await token.approve(registry.address, 1000000000000000, { from: user });
      }
    }))
  ),

  increaseTime: async seconds =>
    new Promise((resolve, reject) => ethRPC.sendAsync({
      method: 'evm_increaseTime',
      params: [seconds],
    }, (err) => {
      if (err) reject(err);
      resolve();
    }))
      .then(() => new Promise((resolve, reject) => ethRPC.sendAsync({
        method: 'evm_mine',
        params: [],
      }, (err) => {
        if (err) reject(err);
        resolve();
      }))),

  getVoteSaltHash: (vote, salt) => (
    `0x${abi.soliditySHA3(['uint', 'uint'], [vote, salt]).toString('hex')}`
  ),

  getListingHash: domain => (
    `0x${abi.soliditySHA3(['string'], [domain]).toString('hex')}`
  ),

  approvePLCR: async (address, adtAmount) => {
    const registry = await Registry.deployed();
    const plcrAddr = await registry.voting.call();
    const token = await Token.deployed();
    await token.approve(plcrAddr, adtAmount, { from: address });
  },

  addToWhitelist: async (domain, deposit, actor, registry) => {
    await utils.as(actor, registry.apply, domain, deposit, '');
    await utils.increaseTime(paramConfig.applyStageLength + 1);
    await utils.as(actor, registry.updateStatus, domain);
  },

  as: (actor, fn, ...args) => {
    function detectSendObject(potentialSendObj) {
      function hasOwnProperty(obj, prop) {
        const proto = obj.constructor.prototype;
        return (prop in obj) &&
          (!(prop in proto) || proto[prop] !== obj[prop]);
      }
      if (typeof potentialSendObj !== 'object') { return undefined; }
      if (
        hasOwnProperty(potentialSendObj, 'from') ||
        hasOwnProperty(potentialSendObj, 'to') ||
        hasOwnProperty(potentialSendObj, 'gas') ||
        hasOwnProperty(potentialSendObj, 'gasPrice') ||
        hasOwnProperty(potentialSendObj, 'value')
      ) {
        throw new Error('It is unsafe to use "as" with custom send objects');
      }
      return undefined;
    }
    detectSendObject(args[args.length - 1]);
    const sendObject = { from: actor };
    return fn(...args, sendObject);
  },

  isEVMException: err => (
    err.toString().includes('revert')
  ),

  // returns block timestamp
  getBlockTimestamp: () => ethQuery.blockNumber()
    .then(num => ethQuery.getBlockByNumber(num, true))
    .then(block => block.timestamp.toString(10)),

  getUnstakedDeposit: async (domain, registry) => {
    // get the struct in the mapping
    const listing = await registry.listings.call(domain);
    // get the unstaked deposit amount from the listing struct
    const unstakedDeposit = await listing[3];
    return unstakedDeposit.toString();
  },

  challengeAndGetPollID: async (domain, actor, registry) => {
    const receipt = await utils.as(actor, registry.challenge, domain, '');
    // NOTE: this returns the FIRST log in the receipt, i.e. the FIRST event that gets emitted
    // return receipt.logs[0].args.challengeID;

    // This returns the first _Challenge log in the receipt
    return utils.getReceiptValue(receipt, 'challengeID', '_Challenge');
  },

  commitVote: async (pollID, voteOption, tokensArg, salt, voter, voting) => {
    const hash = utils.getVoteSaltHash(voteOption, salt);
    await utils.as(voter, voting.requestVotingRights, tokensArg);

    const prevPollID = await voting.getInsertPointForNumTokens.call(voter, tokensArg, pollID);
    await utils.as(voter, voting.commitVote, pollID, hash, tokensArg, prevPollID);
  },

  getReceiptValue: (receipt, arg, event) => {
    if (event) {
      return (receipt.logs.filter(log => log.event === event)[0]).args[arg];
    }
    return receipt.logs[0].args[arg];
  },

  proposeReparamAndGetPropID: async (reParam, value, actor, parameterizer) => {
    const receipt = await utils.as(actor, parameterizer.proposeReparameterization, reParam, value);
    return utils.getReceiptValue(receipt, 'propID', '_ReparameterizationProposal');
  },

  challengeReparamAndGetChallengeID: async (propID, actor, parameterizer) => {
    const receipt = await utils.as(actor, parameterizer.challengeReparameterization, propID);
    return utils.getReceiptValue(receipt, 'challengeID', '_NewChallenge');
  },

  divideAndGetWei: (numerator, denominator) => {
    const weiNumerator = Eth.toWei(BN(numerator), 'gwei');
    return weiNumerator.div(BN(denominator));
  },

  multiplyFromWei: (x, weiBN) => {
    if (!Eth.BN.isBN(weiBN)) {
      return false;
    }
    const weiProduct = BN(x).mul(weiBN);
    return BN(Eth.fromWei(weiProduct, 'gwei'));
  },

  multiplyByPercentage: (x, y, z = 100) => {
    const weiQuotient = utils.divideAndGetWei(y, z);
    return utils.multiplyFromWei(x, weiQuotient);
  },

  getChallengeEpochNumber: async (registry, pollID) => {
    const challenge = await registry.challenges.call(pollID);
    return challenge[6];
  }
};

module.exports = utils;
