var fs = require("fs");
const steem = require('steem');
var utils = require('./utils');

var account = null;
var last_trans = 0;
var members = [];
var whitelist = [];
var config = null;
var first_load = true;
var last_voted = 0;
var skip = false;
var version = '1.1.0';

steem.api.setOptions({ url: 'https://api.steemit.com' });

utils.log("* START - Version: " + version + " *");

// Load the settings from the config file
loadConfig();

// If the API is enabled, start the web server
if(config.api && config.api.enabled) {
  var express = require('express');
  var app = express();

  app.use(function(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
  });

  app.get('/api/members', (req, res) => res.json({ members: members }));
  app.listen(config.api.port, () => utils.log('API running on port ' + config.api.port))
}

// Check if bot state has been saved to disk, in which case load it
if (fs.existsSync('state.json')) {
  var state = JSON.parse(fs.readFileSync("state.json"));

  if (state.last_trans)
    last_trans = state.last_trans;

  if (state.last_voted)
    last_voted = state.last_voted;

  utils.log('Restored saved bot state: ' + JSON.stringify({ last_trans: last_trans, last_voted: last_voted }));
}

// Check if members list has been saved to disk, in which case load it
if (fs.existsSync('members.json')) {
  var members_file = JSON.parse(fs.readFileSync("members.json"));

  members = members_file.members;
	utils.log('Loaded ' + members.length + ' members.');
}

// Schedule to run every minute
setInterval(startProcess, 60 * 1000);

function startProcess() {
  // Load the settings from the config file each time so we can pick up any changes
  loadConfig();

  // Load the bot account info
  steem.api.getAccounts([config.account], function (err, result) {
    if (err || !result)
      console.log(err, result);
    else {
      account = result[0];

      // Check if there are any rewards to claim.
      //claimRewards();
    }
  });

  if (account && !skip) {
    // Load the current voting power of the account
    var vp = utils.getVotingPower(account);

    if (config.detailed_logging)
      utils.log('Voting Power: ' + utils.format(vp / 100) + '% | Time until next vote: ' + utils.toTimer(utils.timeTilFullPower(vp)));

    // We are at 100% voting power - time to vote!
    if (vp >= 10000) {
      skip = true;
      voteNext();
    }

    getTransactions();

    // Save the state of the bot to disk.
    saveState();
  } else if(skip)
    skip = false;
}

function getNextActiveMember(loop_count) {

 utils.log("loop count -> " + loop_count);

	if(!loop_count)
		loop_count = 0;

utils.log("members.length -> " + members.length);

	if(loop_count == members.length)
		return null;

  if (last_voted >= members.length)
    last_voted = 0;

  var member = members[last_voted];

  if(member == null)
    return null;

	// If whitelist_only is enabled, check if this member is still on the whitelist, otherwise skip to the next member
	if(config.whitelist_only && whitelist.indexOf(member.name) < 0) {
		last_voted++;
		utils.log('Member @' + member.name + ' is no longer on the whitelist, skipping...');
		return getNextActiveMember(loop_count + 1);
	}

  utils.log("Date -> " + new Date());

  // Check if this member's membership is active
  if(new Date(member.valid_thru) > new Date()) {
    utils.log("member -> " + member);
    return member;
  } else {
    last_voted++;
    return getNextActiveMember(loop_count + 1);
  }
}

function voteNext() {
  var member = getNextActiveMember();

  //lets go to vote? - portugalcoin
  utils.log("Passou aqui");

  if(member == null)
    return;

//lets go to vote? - portugalcoin
utils.log("Vote to" + member.name);

  steem.api.getDiscussionsByAuthorBeforeDate(member.name, null, new Date().toISOString().split('.')[0], 10, function (err, result) {
    if (result && !err) {
			if(result.length == 0 || !result[0]) {
					utils.log('No posts found for this account: ' + member.name);
					last_voted++;
					return;
			}

      //Yes i´m in - portugalcoin
      utils.log("Yes: " + member.name);

			for(var i = 0; i < result.length; i++) {
				var post = result[i];

				// Make sure the post is less than 6.5 days old
				if((new Date() - new Date(post.created + 'Z')) >= (6.5 * 24 * 60 * 60 * 1000)) {
					utils.log('This post is too old for a vote: ' + post.url);
					continue;
				}

				// Check if the bot already voted on this post
				if(post.active_votes.find(v => v.voter == account.name)) {
					utils.log('Bot already voted on: ' + post.url);
					continue;
				}

        // - portugalcoin
        const last = member.last_trans || -1;
        const last_day = member.last_day || 0;

        // Get today timestamp  - portugalcoin
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf();

        // Is this post in available daily auto bids -- portugalcoin
        const auto_vote = member.last_day === today ? member.auto_vote : 0;
        if (config.daily_vote < auto_vote) return;

				// Check if any tags on this post are blacklisted in the settings
				if ((config.blacklisted_tags && config.blacklisted_tags.length > 0) || (config.whitelisted_tags && config.whitelisted_tags.length > 0) && post.json_metadata && post.json_metadata != '') {
					var tags = JSON.parse(post.json_metadata).tags;

					if((config.blacklisted_tags && config.blacklisted_tags.length > 0) && tags && tags.length > 0 && tags.find(t => config.blacklisted_tags.indexOf(t) >= 0)) {
						utils.log('Post contains one or more blacklisted tags.');
						continue;
					}

					if((config.whitelisted_tags && config.whitelisted_tags.length > 0) && tags && tags.length > 0 && !tags.find(t => config.whitelisted_tags.indexOf(t) >= 0)) {
						utils.log('Post does not contain a whitelisted tag.');
						continue;
					}
				}

				// Check if this post has been flagged by any flag signal accounts
				if(config.flag_signal_accounts) {
					if(post.active_votes.find(function(v) { return v.percent < 0 && config.flag_signal_accounts.indexOf(v.voter) >= 0; })) {
						utils.log('Post was downvoted by a flag signal account.');
						continue;
					}
				}

        //portugalcoin
        //member.last_trans = trans[0];
        member.last_day = today;
        member.auto_vote = auto_vote + 1;

        sendVote(post, 0);
				break;
			}

			last_voted++;
    } else
      console.log(err, result);
  });
}

function sendVote(post, retries) {
  utils.log('Voting on: ' + post.url);

  steem.broadcast.vote(config.posting_key, account.name, post.author, post.permlink, config.vote_weight, function (err, result) {
    if (!err && result) {
      utils.log(utils.format(config.vote_weight / 100) + '% vote cast for: ' + post.url);

			if(config.comment_location)
				sendComment(post.author, post.permlink);
    } else {
      utils.log(err, result);

      // Try again one time on error
      if (retries < 1)
        sendVote(post, retries + 1);
      else {
        utils.log('============= Vote transaction failed two times for: ' + post.url + ' ===============');
      }
    }
  });
}

function sendComment(parentAuthor, parentPermlink) {
  var content = null;

  content = fs.readFileSync(config.comment_location, "utf8");

  // If promotion content is specified in the config then use it to comment on the upvoted post
  if (content && content != '') {

    // Generate the comment permlink via steemit standard convention
    var permlink = 're-' + parentAuthor.replace(/\./g, '') + '-' + parentPermlink + '-' + new Date().toISOString().replace(/-|:|\./g, '').toLowerCase();

    // Replace variables in the promotion content
    content = content.replace(/\{weight\}/g, utils.format(config.vote_weight / 100)).replace(/\{botname\}/g, config.account);

    // Broadcast the comment
    steem.broadcast.comment(config.posting_key, parentAuthor, parentPermlink, account.name, permlink, permlink, content, '{"app":"communitybot/' + version + '"}', function (err, result) {
      if (!err && result) {
        utils.log('Posted comment: ' + permlink);
      } else {
        logError('Error posting comment: ' + permlink);
      }
    });
  }

  // Check if the bot should resteem this post
  if (config.resteem)
    resteem(parentAuthor, parentPermlink);
}

function resteem(author, permlink) {
  var json = JSON.stringify(['reblog', {
    account: config.account,
    author: author,
    permlink: permlink
  }]);

  steem.broadcast.customJson(config.posting_key, [], [config.account], 'follow', json, (err, result) => {
    if (!err && result) {
      utils.log('Resteemed Post: @' + author + '/' + permlink);
    } else {
      utils.log('Error resteeming post: @' + author + '/' + permlink);
    }
  });
}

function getTransactions() {
  var num_trans = 50;

  // If this is the first time the bot is ever being run, start with just the most recent transaction
  if (first_load && last_trans == 0) {
    utils.log('First run - starting with last transaction on account.');
    num_trans = 1;
  }

  // If this is the first time the bot is run after a restart get a larger list of transactions to make sure none are missed
  if (first_load && last_trans > 0) {
    utils.log('First run - loading all transactions since bot was stopped.');
    num_trans = 1000;
  }

  steem.api.getAccountHistory(account.name, -1, num_trans, function (err, result) {
    first_load = false;

    if (err || !result) {
      utils.log(err, result);
      return;
    }

    result.forEach(function (trans) {
      var op = trans[1].op;

      // Check that this is a new transaction that we haven't processed already
      if (trans[0] > last_trans) {

        // We only care about transfers to the bot
        if (op[0] == 'transfer' && op[1].to == account.name) {
          var amount = parseFloat(op[1].amount);
          var currency = utils.getCurrency(op[1].amount);
          utils.log("Incoming Payment! From: " + op[1].from + ", Amount: " + op[1].amount + ", memo: " + op[1].memo);

          if(currency == 'STEEM' && amount >= config.membership.dues_steem) {
            // Update member info
            updateMember(op[1].from, amount, -1);
          }

          // Check if a user is sponsoring another user with their delegation
          if(op[1].memo.startsWith('$sponsor')) {
            var user = op[1].memo.substr(op[1].memo.indexOf('@') + 1);
            sponsorMember(op[1].from, user, amount);
          }

        } else if (op[0] == 'delegate_vesting_shares' && op[1].delegatee == account.name) {

          // Update member info
          updateMember(op[1].delegator, 0, parseFloat(op[1].vesting_shares));

          utils.log('*** Delegation Update - ' + op[1].delegator + ' has delegated ' + op[1].vesting_shares);
        }

        // Save the ID of the last transaction that was processed.
        last_trans = trans[0];
      }
    });
  });
}

function updateMember(name, payment, vesting_shares) {
	// If whitelist_only is enabled, check if the new member is on the whitelist
	if(config.whitelist_only && whitelist.indexOf(name) < 0) {
		sendPayment(name, (payment > 0) ? payment : 0.001, 'STEEM', 'whitelist_only');
		return;
	}

  var member = members.find(m => m.name == name);

  // Add a new member if none is found
  if (!member) {
    member = { name: name, valid_thru: null, vesting_shares: 0, total_dues: 0, joined: new Date(), sponsoring: [], sponsor: null };
    members.push(member);
    utils.log('Added new member: ' + name);
  }

  member.total_dues += payment;

  if(vesting_shares >= 0)
    member.vesting_shares = vesting_shares;

  // Has the member delegated the full amount to the bot?
  member.full_delegation = member.vesting_shares >= config.membership.full_delegation_vests;

  if(!member.full_delegation) {
    // Has the member delegated the minimum amount to the bot?
    var delegation = member.vesting_shares >= config.membership.delegation_vests;

    // Get the date that the membership is currently valid through.
    var valid_thru = new Date(Math.max(new Date(member.valid_thru), new Date(config.membership.start_date), new Date()));

    // Get the dues amount based on whether or not they are a delegator
    var dues = (config.membership.dues_steem_no_delegation == 0 || delegation) ? config.membership.dues_steem : config.membership.dues_steem_no_delegation;

    // Calculate how much longer they have paid for.
    var extension = payment / dues * config.membership.membership_period_days * 24 * 60 * 60 * 1000;

    // Update their membership record.
    member.valid_thru = new Date(valid_thru.valueOf() + extension).toISOString();

    utils.log('Member ' + name + ' valid through: ' + member.valid_thru);
		sendPayment(name, 0.001, 'STEEM', 'member_valid_thru', 0, new Date(valid_thru.valueOf() + extension).toDateString());
  } else
		sendPayment(name, 0.001, 'STEEM', 'member_full_delegation', 0);

  saveMembers();
}

function sponsorMember(sponsor, user, amount) {
  var member = members.find(m => m.name == sponsor);

  if(member && member.vesting_shares >= config.membership.full_delegation_vests) {
    // Subtract the sponsorship amount from the sponsor
    updateMember(member.name, 0, member.vesting_shares - config.membership.full_delegation_vests);

    member.sponsoring.push(user);

    // Add it to the new member
    updateMember(user, 0, config.membership.full_delegation_vests);

    var new_member = members.find(m => m.name == user);

    if(new_member)
      new_member.sponsor = sponsor;
  }
}

function saveState() {
  var state = {
    last_trans: last_trans,
    last_voted: last_voted
  };

  // Save the state of the bot to disk
  fs.writeFile('state.json', JSON.stringify(state), function (err) {
    if (err)
      utils.log(err);
  });
}

function loadConfig() {
	config = JSON.parse(fs.readFileSync("config.json"));

	// Load the whitelist from the specified location
	utils.loadUserList(config.whitelist_location, function(list) {
		if(list)
			whitelist = list;
	});
}

function saveMembers() {
  // Save the members list to disk
  fs.writeFile('members.json', JSON.stringify({ members: members }), function (err) {
    if (err)
      utils.log(err);
  });
}

function sendPayment(to, amount, currency, reason, retries, data) {
  if(!retries)
    retries = 0;

  // Make sure the recipient isn't on the no-refund list (for exchanges and things like that).
  if (reason != 'forward_payment' && config.no_refund && config.no_refund.indexOf(to) >= 0) {
    utils.log("Payment not sent to: @" + to + " for: " + reason + ' because they are on the no_refund list.');
    return;
  }

  // Replace variables in the memo text
  var memo = config.transfer_memos[reason];
  memo = memo.replace(/{amount}/g, utils.format(amount, 3) + ' ' + currency);
  memo = memo.replace(/{currency}/g, currency);
  memo = memo.replace(/{account}/g, config.account);
	memo = memo.replace(/{to}/g, to);
  memo = memo.replace(/{tag}/g, data);

  // Issue the payment.- portugalcoin no payment
  /*steem.broadcast.transfer(config.active_key, config.account, to, utils.format(amount, 3) + ' ' + currency, memo, function (err, response) {
    if (err) {
      utils.log('Error sending payment to @' + to + ' for: ' + amount + ' ' + currency + ', Error: ' + err);

      // Try again on error
      if(retries < 2)
        setTimeout(function() { refund(to, amount, currency, reason, retries + 1, data) }, (Math.floor(Math.random() * 10) + 3) * 1000);
      else
        utils.log('============= Payment failed three times for: @' + to + ' ===============');
    } else {
      utils.log('Payment of ' + amount + ' ' + currency + ' sent to @' + to + ' for reason: ' + reason);
    }
  });*/
}

function claimRewards() {
  if (!config.auto_claim_rewards)
    return;

  // Make api call only if you have actual reward
  if (parseFloat(account.reward_steem_balance) > 0 || parseFloat(account.reward_sbd_balance) > 0 || parseFloat(account.reward_vesting_balance) > 0) {
    steem.broadcast.claimRewardBalance(config.posting_key, config.account, account.reward_steem_balance, account.reward_sbd_balance, account.reward_vesting_balance, function (err, result) {
      if (err) {
        utils.log(err);
      }

      if (result) {

        var rewards_message = "$$$ ==> Rewards Claim";
        if (parseFloat(account.reward_sbd_balance) > 0) { rewards_message = rewards_message + ' SBD: ' + parseFloat(account.reward_sbd_balance); }
        if (parseFloat(account.reward_steem_balance) > 0) { rewards_message = rewards_message + ' STEEM: ' + parseFloat(account.reward_steem_balance); }
        if (parseFloat(account.reward_vesting_balance) > 0) { rewards_message = rewards_message + ' VESTS: ' + parseFloat(account.reward_vesting_balance); }

        utils.log(rewards_message);

        // If there are liquid post rewards, withdraw them to the specified account
        if (parseFloat(account.reward_sbd_balance) > 0 && config.post_rewards_withdrawal_account && config.post_rewards_withdrawal_account != '') {

          // Send liquid post rewards to the specified account
          steem.broadcast.transfer(config.active_key, config.account, config.post_rewards_withdrawal_account, account.reward_sbd_balance, 'Liquid Post Rewards Withdrawal', function (err, response) {
            if (err)
              utils.log(err, response);
            else {
              utils.log('$$$ Auto withdrawal - liquid post rewards: ' + account.reward_sbd_balance + ' sent to @' + config.post_rewards_withdrawal_account);
            }
          });
        }
      }
    });
  }
}
