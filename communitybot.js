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
//setInterval(startProcess, 60 * 1000);
setInterval(startProcess, 10 * 1000);

function startProcess() {
  // Load the settings from the config file each time so we can pick up any changes
  loadConfig();

  // Load the bot account info
  steem.api.getAccounts([config.account], function (err, result) {
    if (err || !result)
      console.log(err, result);
    else {
      account = result[0];
    }
  });

  if (account && !skip) {
    // Load the current voting power of the account
    var vp = utils.getVotingPower(account);

    if (config.detailed_logging)
      utils.log('Voting Power: ' + utils.format(vp / 100) + '% | Time until next vote: ' + utils.toTimer(utils.timeTilFullPower(vp)));

    // We are at 60% voting power - time to vote!
    if (vp >= 6000) {
      skip = true;
      voteNext();
    }

    // Save the state of the bot to disk.
    saveState();
  } else if(skip)
    skip = false;
}

function getNextActiveMember(loop_count) {

	if(!loop_count)
		loop_count = 0;

  utils.log("Number of community members: " + members.length);

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
    return member;

}

function AddMinutesToDate(date, minutes) {
  return new Date(date.getTime() + minutes*60000);
}

function DateFormat(date){
  var days=date.getDate();
  var year=date.getFullYear();
  var month=(date.getMonth()+1);
  var hours = date.getHours();
  var minutes = date.getMinutes();
  minutes = minutes < 10 ? '0'+ minutes : minutes;
  var strTime =days+'/'+month+'/'+year+'/ '+hours + ':' + minutes;
  return strTime;
}

function voteNext() {
  var member = getNextActiveMember();

  if(member == null)
    return;

  // Get today timestamp
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf();

  if(member.auto_vote > 0 && member.last_day == today){
    utils.log( 'This member: ' + member.name + ' already voted today'  );
    utils.log( 'This member have today vote : ' + member.auto_vote  );
    last_voted++;
    member = getNextActiveMember();
    return;
  }

  steem.api.getDiscussionsByAuthorBeforeDate(member.name, null, new Date().toISOString().split('.')[0], 1, function (err, result) {
    if (result && !err) {
			if(result.length == 0 || !result[0]) {
					utils.log('No posts found for this account: ' + member.name);
					last_voted++;
					return;
			}

			for(var i = 0; i < result.length; i++) {
				var post = result[i];

        var now = new Date();
        // Make sure the post is less or more than 15 minutes old
        if((new Date(AddMinutesToDate(new Date(post.created + 'Z'),config.minutes_vote))) < new Date()) {
          utils.log('*** This post has MORE than '+ config.minutes_vote +' minutes for member: '+ member.name);
        }else{
          utils.log('*** This post has LESS than '+ config.minutes_vote +' minutes for member: '+ member.name);
          continue;
        }

				// Make sure the post is less than 1 days old
				if((new Date() - new Date(post.created + 'Z')) >= (1 * 24 * 60 * 60 * 1000)) {
					utils.log('This post is too old for a vote: ' + post.url);
					continue;
				}

				// Check if the bot already voted on this post
				if(post.active_votes.find(v => v.voter == account.name)) {
					utils.log('Bot already voted on: ' + post.url);
					continue;
				}

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

        sendVote(member.name, post, 0);
        getMembersPosts(member);
				break;
			}

			last_voted++;
    } else
      console.log(err, result);
  });
}

function sendVote(name, post, retries) {
  utils.log('Voting on: ' + post.url);

  var member = members.find(m => m.name == name);

  //If it is not delegator receives 10% of the value. - portugalcoin
  if(member.vesting_shares > 0){

    //Total de SP do bot
    steem.api.getAccounts(['steemitportugal'], function(err, result) {
     var received_vesting_shares = result[0].received_vesting_shares.split(' ')[0];

     var weight_delegator_vote = (member.vesting_shares / received_vesting_shares) * 10000;
     utils.log( 'SP Value Member: ' + member.vesting_shares  );
     utils.log( 'Received Vesting Shares: ' + received_vesting_shares  );
     utils.log( 'Vote Weight: ' + weight_delegator_vote  );

     //Member delegator have community % vote weight more % of your delegation
     config.vote_weight = weight_delegator_vote + config.member_weight;
    });

  }else{
    //Member not delegator have % vote weight
    config.vote_weight = config.member_weight;
  }

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

function getMembersPosts(member) {

    // Get this delegator account history
    steem.api.getAccountHistory(member.name, -1, 1, (err, result) => {
      if (err || !result) {
        logError('Error loading member account history: ' + err);

        return;
      }

      result.reverse();

      // Go through the result and find post transactions
      result.map(trans => {
        const last = member.last_trans || -1;
        const last_day = member.last_day || 0;

        // Get today timestamp
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf();

        // Is this new?
        if (trans[0] <= last) return;

        // Is this post in available daily auto vote
        var auto_vote = 0;
        if( member.last_day == today){
          utils.log('*** Member ' + member.name + ' already had a vote today ***');
          auto_vote = member.auto_vote;
          return;
        }else{
          auto_vote = 0;
          member.auto_vote = 0;
        }

        if (config.daily_vote < auto_vote) return;

        const op = trans[1].op;

        // Save this as last transaction
        member.last_trans = trans[0];
        member.last_day = today;
        member.auto_vote = auto_vote + 1;

        utils.log('*** Member Auto Vote: ' + member.name);
        utils.log('*** Last day: ' + member.last_day);
        utils.log('*** Member Auto Vote: ' + member.auto_vote);

      });
    });

  // Save the updated list of delegators to disk
  updateMember(member.name,0, member.vesting_shares, member.last_day, member.auto_vote);
}

function updateMember(name, payment, vesting_shares, last_day, auto_vote) {

  var member = members.find(m => m.name == name);

  // Add a new member if none is found
  if (!member) {
    member = { name: name, valid_thru: null, vesting_shares: 0, total_dues: 0, joined: new Date(), sponsoring: [], sponsor: null, last_trans:0, last_day:0, auto_vote: 0 };
    members.push(member);
    utils.log('Added new member: ' + name);
  }

  //member.total_dues += payment;

  if(vesting_shares >= 0)
    member.vesting_shares = vesting_shares;

  saveMembers(name, vesting_shares, last_day, auto_vote);
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

function saveMembers( name, vesting_shares, last_day, auto_vote ) {

  utils.log('New save JSON member: ' + name);

  //Update json file member
  for (i in members.members) {
    for (j in members.members[i].name) {
      if(members.members[i].name == members.name)
        members.members[i].last_day = last_day;
        members.members[i].auto_vote = auto_vote;
        utils.log('Entrou: ' + members.members[i].name);
    }
 }

  // Save the members list to disk
  fs.writeFile('members.json', JSON.stringify({ members: members }), function (err) {
    if (err)
      utils.log(err);
  });
}
