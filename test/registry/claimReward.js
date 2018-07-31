/* eslint-env mocha */
/* global assert contract */
const fs = require('fs');
const BN = require('bignumber.js');

const config = JSON.parse(fs.readFileSync('./conf/config.json'));
const paramConfig = config.paramDefaults;

const utils = require('../utils.js');

const bigTen = number => new BN(number.toString(10), 10);

contract('Registry', (accounts) => {
  describe('Function: claimReward', () => {
    const [applicant, challenger, voterAlice, voterBob] = accounts;
    const minDeposit = bigTen(paramConfig.minDeposit);

    let token;
    let voting;
    let registry;
    let bank;

    beforeEach(async () => {
      const { votingProxy, registryProxy, tokenInstance, bankInstance } = await utils.getProxies();
      voting = votingProxy;
      registry = registryProxy;
      token = tokenInstance;
      bank = bankInstance;

      await utils.approveProxies(accounts, token, voting, false, registry);
    });

    it('should transfer the correct number of tokens once a challenge has been resolved', async () => {
      const listing = utils.getListingHash('claimthis.net');

      // Apply
      await utils.as(applicant, registry.apply, listing, minDeposit, '');
      const aliceStartingBalance = await token.balanceOf.call(voterAlice);

      // Challenge
      const pollID = await utils.challengeAndGetPollID(listing, challenger, registry);

      // Alice is so committed
      await utils.commitVote(pollID, '0', 500, '420', voterAlice, voting);
      await utils.increaseTime(paramConfig.commitStageLength + 1);

      // Alice is so revealing
      await utils.as(voterAlice, voting.revealVote, pollID, '0', '420');
      await utils.increaseTime(paramConfig.revealStageLength + 1);

      // Update status
      await utils.as(applicant, registry.updateStatus, listing);

      // Alice claims reward
      const aliceVoterReward = await registry.voterReward(voterAlice, pollID, '420');
      await utils.as(voterAlice, registry.claimReward, pollID, '420');

      // Alice withdraws her voting rights
      await utils.as(voterAlice, voting.withdrawVotingRights, '500');

      const aliceExpected = aliceStartingBalance.add(aliceVoterReward);
      const aliceFinalBalance = await token.balanceOf.call(voterAlice);

      assert.strictEqual(
        aliceFinalBalance.toString(10), aliceExpected.toString(10),
        'alice should have the same balance as she started',
      );
    });

    it('should revert if challenge does not exist', async () => {
      const listing = utils.getListingHash('reversion.net');
      await utils.addToWhitelist(listing, minDeposit, applicant, registry);

      try {
        const nonPollID = '666';
        await utils.as(voterAlice, registry.claimReward, nonPollID, '420');
        assert(false, 'should not have been able to claimReward for non-existant challengeID');
      } catch (err) {
        assert(utils.isEVMException(err), err.toString());
      }
    });

    it('should revert if provided salt is incorrect', async () => {
      const listing = utils.getListingHash('sugar.net');

      const applicantStartingBalance = await token.balanceOf.call(applicant);
      const aliceStartBal = await token.balanceOf.call(voterAlice);
      await utils.addToWhitelist(listing, minDeposit, applicant, registry);

      const pollID = await utils.challengeAndGetPollID(listing, challenger, registry);

      // Alice is so committed
      await utils.commitVote(pollID, '0', 500, '420', voterAlice, voting);
      await utils.increaseTime(paramConfig.commitStageLength + 1);

      // Alice is so revealing
      await utils.as(voterAlice, voting.revealVote, pollID, '0', '420');
      await utils.increaseTime(paramConfig.revealStageLength + 1);

      const applicantFinalBalance = await token.balanceOf.call(applicant);
      const aliceFinalBalance = await token.balanceOf.call(voterAlice);
      const expectedBalance = applicantStartingBalance.sub(minDeposit);

      assert.strictEqual(
        applicantFinalBalance.toString(10), expectedBalance.toString(10),
        'applicants final balance should be what they started with minus the minDeposit',
      );
      assert.strictEqual(
        aliceFinalBalance.toString(10), (aliceStartBal.sub(bigTen(500))).toString(10),
        'alices final balance should be exactly the same as her starting balance',
      );

      // Update status
      await utils.as(applicant, registry.updateStatus, listing);

      try {
        await utils.as(voterAlice, registry.claimReward, pollID, '421');
        assert(false, 'should not have been able to claimReward with the wrong salt');
      } catch (err) {
        assert(utils.isEVMException(err), err.toString());
      }
    });

    it('should not transfer tokens if msg.sender has already claimed tokens for a challenge', async () => {
      const listing = utils.getListingHash('sugar.net');

      const applicantStartingBalance = await token.balanceOf.call(applicant);
      const aliceStartingBalance = await token.balanceOf.call(voterAlice);

      await utils.addToWhitelist(listing, minDeposit, applicant, registry);

      // Challenge
      const pollID = await utils.challengeAndGetPollID(listing, challenger, registry);

      // Alice is so committed
      await utils.commitVote(pollID, '0', 500, '420', voterAlice, voting);
      await utils.increaseTime(paramConfig.commitStageLength + 1);

      // Alice is so revealing
      await utils.as(voterAlice, voting.revealVote, pollID, '0', '420');
      await utils.increaseTime(paramConfig.revealStageLength + 1);

      // Update status
      await utils.as(applicant, registry.updateStatus, listing);

      // Claim reward
      await utils.as(voterAlice, registry.claimReward, pollID, '420');

      try {
        await utils.as(voterAlice, registry.claimReward, pollID, '420');
        assert(false, 'should not have been able to call claimReward twice');
      } catch (err) {
        assert(utils.isEVMException(err), err.toString());
      }

      const applicantEndingBalance = await token.balanceOf.call(applicant);
      const appExpected = applicantStartingBalance.sub(minDeposit);

      const aliceEndingBalance = await token.balanceOf.call(voterAlice);
      const aliceExpected = aliceStartingBalance.add(minDeposit.div(bigTen(2))).sub(bigTen(500));

      assert.strictEqual(
        applicantEndingBalance.toString(10), appExpected.toString(10),
        'applicants ending balance is incorrect',
      );
      assert.strictEqual(
        aliceEndingBalance.toString(10), aliceExpected.toString(10),
        'alices ending balance is incorrect',
      );
    });

    it('should not transfer tokens for an unresolved challenge', async () => {
      const listing = utils.getListingHash('unresolved.net');

      const applicantStartingBalance = await token.balanceOf.call(applicant);
      const aliceStartingBalance = await token.balanceOf.call(voterAlice);

      await utils.addToWhitelist(listing, minDeposit, applicant, registry);

      // Challenge
      const pollID = await utils.challengeAndGetPollID(listing, challenger, registry);

      // Alice is so committed
      await utils.commitVote(pollID, '0', 500, '420', voterAlice, voting);
      await utils.increaseTime(paramConfig.commitStageLength + 1);

      // Alice is so revealing
      await utils.as(voterAlice, voting.revealVote, pollID, '0', '420');
      await utils.increaseTime(paramConfig.revealStageLength + 1);

      try {
        await utils.as(voterAlice, registry.claimReward, pollID, '420');
        assert(false, 'should not have been able to claimReward for unresolved challenge');
      } catch (err) {
        assert(utils.isEVMException(err), err.toString());
      }

      const applicantEndingBalance = await token.balanceOf.call(applicant);
      const appExpected = applicantStartingBalance.sub(minDeposit);

      const aliceEndingBalance = await token.balanceOf.call(voterAlice);
      const aliceExpected = aliceStartingBalance.sub(bigTen(500));

      assert.strictEqual(
        applicantEndingBalance.toString(10), appExpected.toString(10),
        'applicants ending balance is incorrect',
      );
      assert.strictEqual(
        aliceEndingBalance.toString(10), aliceExpected.toString(10),
        'alices ending balance is incorrect',
      );
    });

    it('should add the correct amount of tokens to an epoch.voterTokens', async () => {
      const listing = utils.getListingHash('epochDetails.net');
      // Apply
      await utils.as(applicant, registry.apply, listing, minDeposit, '');
      // Challenge
      const pollID = await utils.challengeAndGetPollID(listing, challenger, registry);
      // Record Alice's starting balance
      const aliceStartingBalance = await token.balanceOf.call(voterAlice);
      // Alice is so committed
      await utils.commitVote(pollID, '0', '500', '420', voterAlice, voting);
      await utils.increaseTime(paramConfig.commitStageLength + 1);
      // Alice is so revealing
      await utils.as(voterAlice, voting.revealVote, pollID, '0', '420');
      await utils.increaseTime(paramConfig.revealStageLength + 1);
      // Update status
      await utils.as(applicant, registry.updateStatus, listing);

      // Alice claims reward
      const aliceVoterReward = await registry.voterReward(voterAlice, pollID, '420');
      await utils.as(voterAlice, registry.claimReward, pollID, '420');

      const epochNumber = await utils.getChallengeEpochNumber(registry, pollID);

      const aliceEpochVoterTokens = await bank.getEpochVoterTokens.call(epochNumber, voterAlice);
      assert.strictEqual(aliceEpochVoterTokens.toString(), '500', 'epoch should have returned the correct number of tokens');

      // Alice withdraws her voting rights
      await utils.as(voterAlice, voting.withdrawVotingRights, '500');

      // Alice's balance should be her starting + her reward
      const aliceExpected = aliceStartingBalance.add(aliceVoterReward);
      const aliceFinalBalance = await token.balanceOf.call(voterAlice);

      assert.strictEqual(
        aliceFinalBalance.toString(10), aliceExpected.toString(10),
        'alice should have the same balance as she started',
      );
    });

    it('should add the correct amount of tokens to an epoch.voterTokens for multiple voters on a single epoch', async () => {
      const listing = utils.getListingHash('epochDetails.net');
      // Apply
      await utils.as(applicant, registry.apply, listing, minDeposit, '');
      // Challenge
      const pollID = await utils.challengeAndGetPollID(listing, challenger, registry);
      // Record Alice's & Bob's starting balances
      const aliceStartingBalance = await token.balanceOf.call(voterAlice);
      const bobStartingBalance = await token.balanceOf.call(voterAlice);
      // Alice and Bob are so committed
      await utils.commitVote(pollID, '0', '500', '420', voterAlice, voting);
      await utils.commitVote(pollID, '0', '600', '420', voterBob, voting);
      await utils.increaseTime(paramConfig.commitStageLength + 1);
      // Alice is so revealing
      await utils.as(voterAlice, voting.revealVote, pollID, '0', '420');
      await utils.as(voterBob, voting.revealVote, pollID, '0', '420');
      await utils.increaseTime(paramConfig.revealStageLength + 1);
      // Update status
      await utils.as(applicant, registry.updateStatus, listing);

      // Alice claims reward
      const aliceVoterReward = await registry.voterReward(voterAlice, pollID, '420');
      await utils.as(voterAlice, registry.claimReward, pollID, '420');
      // Bob claims reward
      const bobVoterReward = await registry.voterReward(voterBob, pollID, '420');
      await utils.as(voterBob, registry.claimReward, pollID, '420');

      const epochNumber = await utils.getChallengeEpochNumber(registry, pollID);

      const aliceEpochVoterTokens = await bank.getEpochVoterTokens.call(epochNumber, voterAlice);
      assert.strictEqual(aliceEpochVoterTokens.toString(), '500', 'epoch should have returned the correct number of tokens');
      const bobEpochVoterTokens = await bank.getEpochVoterTokens.call(epochNumber, voterBob);
      assert.strictEqual(bobEpochVoterTokens.toString(), '600', 'epoch should have returned the correct number of tokens');

      // Alice withdraws her voting rights
      await utils.as(voterAlice, voting.withdrawVotingRights, '500');
      // Alice's balance should be her starting + her reward
      const aliceExpected = aliceStartingBalance.add(aliceVoterReward);
      const aliceFinalBalance = await token.balanceOf.call(voterAlice);
      assert.strictEqual(
        aliceFinalBalance.toString(10), aliceExpected.toString(10),
        'alice should have the same balance as she started',
      );

      // Bob withdraws his voting rights
      await utils.as(voterBob, voting.withdrawVotingRights, '600');
      // Bob's balance should be his starting + his reward
      const bobExpected = bobStartingBalance.add(bobVoterReward);
      const bobFinalBalance = await token.balanceOf.call(voterBob);
      assert.strictEqual(
        bobFinalBalance.toString(10), bobExpected.toString(10),
        'bob should have the same balance as he started',
      );
    });
  });
});

