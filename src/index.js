require('colors')

const fs = require('fs')
const _ = require('lodash')
const mkdirp = require('mkdirp')
const path = require('path')
const promisify = require('promisify-node')
const { stringify } = require('query-string')
const unesc = require('unescape')

const DeltaBoards = require('./delta-boards')
const { deltaLogDB } = require('./db')
const Reddit = require('./reddit-api-driver')
const {
  generateDeltaBotCommentFromDeltaCommentDEPRECATED,
  getDeltaBotReply,
  getCommentAuthor,
  getWikiContent,
  parseHiddenParams,
  stringifyObjectToBeHidden,
  formatAwardedText,
  parseCommentIdFromURL,
  checkCommentForDelta,
} = require('./utils');

(async () => {
  const i18n = require(path.resolve('i18n'))

  const deltaLogEnabled = _.some(process.argv, arg => arg === '--enable-delta-log')

  const last = []
  setInterval(() => {
    const now = Date.now()
    if (now < last[0] + 1800000 || now < last[1] + 1800000) process.exit(1)
  }, 3600000)

  const locale = 'en-us'
  mkdirp.sync('./config/state')

  fs.writeFile = promisify(fs.writeFile)
  const credentials = require(path.resolve('./config/credentials/credentials.json'))

  const packageJson = require(path.resolve('./package.json'))

  const configJsonPath = path.join(process.cwd(), 'config/config.json')
  const configJson = require(path.resolve(configJsonPath))

  const deltaLogSubreddit = configJson.deltaLogSubreddit
  const subreddit = configJson.subreddit
  const botUsername = credentials.username
  const flags = { deltaLogEnabled }
  const reddit = new Reddit(credentials, packageJson.version, 'main', flags)

  const addOrRemoveDeltaToOrFromWiki = async ({
    createdUTC,
    user,
    linkTitle,
    id,
    linkURL,
    author,
    action,
    mode,
  }) => { // returns flair count
    const createWikiHiddenParams = async (content, paramMode) => {
      try {
        const hiddenParams = {
          comment: i18n[locale].hiddenParamsComment,
          deltas: [],
          deltasGiven: [],
        }
        if (content) {
          const contextNumber = paramMode === 'receive' ? '2' : '3' // 2=Receive, 3=Give
          const links = _.uniq(
            content.match(new RegExp(`/r/${subreddit}/comments/.+?context=${contextNumber}`, 'g'))
          )
          const arrayFullnames = (
            _(links)
              .reduce((a, e, i) => {
                const arrayIndex = Math.floor(i / 100)
                a[arrayIndex] = a[arrayIndex] || []
                a[arrayIndex].push(
                  `t1_${e.replace(
                    e.slice(0, e.lastIndexOf('/') + 1), ''
                  ).replace(`?context=${contextNumber}`, '')}`
                )
                return a
              }, [])
              .map(e => e.join(','))
          )
          if (arrayFullnames.length === 0) {
            return hiddenParams
          }
          await new Promise(async (res, rej) => {
            _.forEach(arrayFullnames, async (fullnames) => {
              try {
                const commentRes = await reddit.query(
                  `/r/${subreddit}/api/info?${stringify({ id: fullnames })}`
                )
                if (commentRes.error) throw Error(commentRes.error)
                const comments = _.get(commentRes, 'data.children')
                const fullLinkIds = _.reduce(comments, (array, comment) => {
                  const linkId = _.get(comment, 'data.link_id')
                  array.push(linkId)
                  return array
                }, []).join(',')
                const listingsRes = await reddit.query(
                  `/r/${subreddit}/api/info?${stringify({ id: fullLinkIds })}`
                )
                const listingsData = _.get(listingsRes, 'data.children')
                const titles = _.reduce(listingsData, (array, listing) => {
                  const title = _.get(listing, 'data.title').replace(/\)/g, 'AXDK9vhFALCkjXPmwvSB')
                  array.push(title)
                  return array
                }, [])
                const baseUrls = _.reduce(listingsData, (array, listing) => {
                  const title = (
                    _.get(listing, 'data.permalink')
                      .replace(/\)/g, 'AXDK9vhFALCkjXPmwvSB')
                  )
                  array.push(title)
                  return array
                }, [])
                _.forEach(comments, (comment, i) => {
                  const name = (
                    _.get(comment, 'data.name')
                      .replace('t1_', '') // this is the comment id
                  )
                  const base = baseUrls[i]
                  const title = titles[i]
                  const awardedBy = _.get(comment, 'data.author')
                  const unixUTC = _.get(comment, 'data.created_utc')
                  const params = {
                    b: base,
                    dc: name,
                    t: title,
                    ab: awardedBy,
                    uu: unixUTC,
                  }
                  if (paramMode === 'receive') {
                    hiddenParams.deltas.push(params)
                  } else if (paramMode === 'give') {
                    hiddenParams.deltasGiven.push(params)
                  } else {
                    console.log('No valid mode given for createWikiHiddenParams. Please set mode to \'give\' or \'receive\''.red)
                  }
                })
                if (paramMode === 'receive') {
                  if (hiddenParams.deltas.length === links.length) res()
                } else if (paramMode === 'give') {
                  if (hiddenParams.deltasGiven.length === links.length) res()
                } else {
                  console.log('No valid mode given for createWikiHiddenParams. Please set mode to \'give\' or \'receive\''.red)
                }
              } catch (err) {
                console.log(err)
              }
            })
            setTimeout(() => rej(), 60000)
          })
          return hiddenParams
        }
        return hiddenParams
      } catch (err) {
        console.log('216 - failed to create wiki hidden params')
        console.log(err)
        return {
          comment: i18n[locale].hiddenParamsComment,
          deltas: [],
          deltasGiven: [],
        }
      }
    }
    const userToModify = mode === 'receive' ? user : author
    let content = await getWikiContent({
      api: reddit,
      wikiPage: `user/${userToModify}`,
      subreddit,
    })
    // First, find all wiki pages and combine for parsing
    if (content && content.indexOf('Any delta history before February 2015 can be found at') > -1) {
      const oldContent = await getWikiContent(`userhistory/user/${user}`)
      content += oldContent
    }
    // Look for hidden params. If not there, create
    let hiddenParams = parseHiddenParams(content)
    if (!hiddenParams) {
      // Need to create both "deltas" and "deltasGiven" if hidden params aren't there
      hiddenParams = await createWikiHiddenParams(content, 'receive')
      const hiddenParamsGiven = await createWikiHiddenParams(content, 'give')
      hiddenParams.deltasGiven = hiddenParamsGiven.deltasGiven
    } else {
      // If hidden params are there, deltas will almost always be there
      // Still doesn't hurt to create a default
      if (hiddenParams.deltas === undefined) {
        const hiddenParamsReceived = await createWikiHiddenParams(content, 'receive')
        hiddenParams.delta = hiddenParamsReceived.deltasGiven
      }
      // If hidden params are there, no existing users will have deltasGiven defined
      // since it's a new feature. Create it
      if (hiddenParams.deltasGiven === undefined) {
        const hiddenParamsGiven = await createWikiHiddenParams(content, 'give')
        hiddenParams.deltasGiven = hiddenParamsGiven.deltasGiven
      }
    }
    if (action === 'add') {
      if (mode === 'receive') {
        hiddenParams.deltas.push({
          b: linkURL,
          dc: id,
          t: linkTitle.replace(/\)/g, 'AXDK9vhFALCkjXPmwvSB'),
          ab: author,
          uu: createdUTC,
        })
      } else if (mode === 'give') {
        hiddenParams.deltasGiven.push({
          b: linkURL,
          dc: id,
          t: linkTitle.replace(/\)/g, 'AXDK9vhFALCkjXPmwvSB'),
          ab: user,
          uu: createdUTC,
        })
      } else {
        console.log('No valid mode given for addOrRemoveDeltaToOrFromWiki. Please set mode to \'give\' or \'receive\''.red)
      }
    } else if (action === 'remove') {
      if (mode === 'receive') {
        _.remove(hiddenParams.deltas, { dc: id })
      } else if (mode === 'give') {
        _.remove(hiddenParams.deltasGiven, { dc: id })
      } else {
        console.log('No valid mode given for addOrRemoveDeltaToOrFromWiki. Please set mode to \'give\' or \'receive\''.red)
      }
    } else console.log('No action called for addOrRemoveDeltaToOrFromWiki'.red)
    hiddenParams.deltas = _.uniqBy(hiddenParams.deltas, 'dc')
    hiddenParams.deltas = _.sortBy(hiddenParams.deltas, ['uu'])
    hiddenParams.deltasGiven = _.uniqBy(hiddenParams.deltasGiven, 'dc')
    hiddenParams.deltasGiven = _.sortBy(hiddenParams.deltasGiven, ['uu'])
    const deltaCountReceived = hiddenParams.deltas.length
    const deltaCountGiven = hiddenParams.deltasGiven.length
    // eslint-disable-next-line
    let newContent = `${stringifyObjectToBeHidden(hiddenParams)}\r\n\r\n#Bravo History for u/${userToModify}\r\n\r\n##Bravos Received\r\n\r\n/u/${userToModify} has received ${deltaCountReceived} Bravo${deltaCountReceived === 1 ? '' : 's'}:\r\n\r\n| Date | Submission | Bravo Comment | Awarded By |\r\n| :------: | :------: | :------: | :------: |\r\n`
    _.forEachRight(hiddenParams.deltas, (col) => {
      const { b, dc, t, ab, uu } = col
      const date = new Date(uu * 1000)
      const [month, day, year] = [date.getMonth() + 1, date.getDate(), date.getFullYear()]
      const newRow = (
        `|${month}/${day}/${year}|[${t.replace(
          /AXDK9vhFALCkjXPmwvSB/g, ')'
        )}](${b})|[Link](${b}${dc}?context=2)|/u/${ab}|\r\n`
      )
      newContent += newRow
    })
    newContent += `\r\n\r\n##Bravos Given\r\n\r\n/u/${userToModify} has given ${deltaCountGiven} delta${deltaCountGiven === 1 ? '' : 's'}:\r\n\r\n| Date | Submission | Bravo Comment | Awarded To |\r\n| :------: | :------: | :------: | :------: |\r\n`
    _.forEachRight(hiddenParams.deltasGiven, (col) => {
      const { b, dc, t, ab, uu } = col
      const date = new Date(uu * 1000)
      const [month, day, year] = [date.getMonth() + 1, date.getDate(), date.getFullYear()]
      const newRow = (
        `|${month}/${day}/${year}|[${t.replace(
          /AXDK9vhFALCkjXPmwvSB/g, ')'
        )}](${b})|[Link](${b}${dc}?context=3)|/u/${ab}|\r\n`
      )
      newContent += newRow
    })
    const wikiEditReason = mode === 'receive' ? 'Added a delta received' : 'Added a delta given'
    const query = {
      page: `user/${userToModify}`,
      reason: wikiEditReason,
      content: newContent,
    }
    const response = await reddit.query(
      { URL: `/r/${subreddit}/api/wiki/edit`, method: 'POST', body: stringify(query) }
    )
    if (response.error) throw Error(response.error)
    return deltaCountReceived
  }

  const updateFlair = async ({ name, flairCount }) => {
    const flairQuery = {
      name,
      text: `${flairCount}ß`,
    }
    const response = await reddit.query(
      { URL: `/r/${subreddit}/api/flair?${stringify(flairQuery)}`, method: 'POST' }
    )
    if (response.error) throw Error(response.error)
    return true
  }

  const introductoryTemplate = _.template(i18n[locale].firstDeltaMessage)
  const sendIntroductoryMessage = async ({ username, flairCount }) => {
    if (flairCount === 1) {
      const introMessageContent = {
        to: username,
        subject: i18n[locale].firstDeltaSubject,
        text: introductoryTemplate({ username, subreddit }),
      }
      const response = await reddit.query(
        { URL: `/r/${subreddit}/api/compose?${stringify(introMessageContent)}`, method: 'POST' }
      )
      if (response.error) throw Error(response.error)
    }
    return true
  }

  const distinguishThing = async (args) => {
    const distinguishResp = await reddit.query({
      URL: `/api/distinguish?${stringify(args)}`,
      method: 'POST',
    })
    if (distinguishResp.error) throw Error(distinguishResp.error)
    return true
  }

  const makeComment = async (commentArgs) => {
    const send = await reddit.query({
      URL: `/api/comment?${stringify(commentArgs.content)}`,
      method: 'POST',
    })
    if (send.error) throw Error(send.error)
    const flattened = _.flattenDeep(send.jquery)
    const commentFullName = _.get(_.find(flattened, 'data.name'), 'data.name')
    await distinguishThing({ id: commentFullName, how: 'yes', sticky: !!commentArgs.sticky })
    return commentFullName
  }

  const findDeltaLogPost = async (linkID) => {
    try {
      return await _.identity(deltaLogDB.get(linkID))
    } catch (err) {
      console.error('Failed to find delta log post', err)
      return null
    }
  }

  const wasDeltaMadeByAuthor = comment => comment.link_author === getCommentAuthor(comment)

  /* Invoked after the DeltaLog post is made */
  const deltaLogStickyTemplate = _.template(i18n[locale].deltaLogSticky)
  const findOrMakeStickiedComment = async (linkID, comment, deltaLogPost) => {
    let stickyID = deltaLogPost.wikientry.stickiedCommentID
    const opName = deltaLogPost.postentry.opUsername
    const deltasAwardedByOP = deltaLogPost.postentry.comments.filter(
      comm => comm.awardingUsername === opName
    ).length
    const awardStr = deltasAwardedByOP + ((deltasAwardedByOP === 1) ? ' delta' : ' deltas')

    if (!wasDeltaMadeByAuthor(comment)) {
      return true
    }
    const wikiPostObject = await findDeltaLogPost(linkID)
    if (wikiPostObject == null) {
      console.error(`Unable to find delta log post for thread ${linkID} - should have been made by findOrMakeDeltaLogPost! Skipping sticky comment creation`)
      return true
    }

    if (!stickyID) {
      const postComments = await reddit.query(`/r/${subreddit}/comments/${linkID}.json`, true)
      const toplevelReplies = _.get(postComments, '[1].data.children')
      _.each(toplevelReplies, (topLevelComment) => {
        if (topLevelComment.author === botUsername && topLevelComment.stickied) {
          stickyID = comment.name
        }
      })
    }
    if (stickyID) {
    // Update the N in 'OP has awarded N deltas...'
      const stickyCommentBody = deltaLogStickyTemplate({
        username: opName,
        linkToPost: `/r/${deltaLogSubreddit}/comments/${deltaLogPost.wikientry.deltaLogPostID}`,
        deltaLogSubreddit,
        opawarded: awardStr,
      })

      const updateParams = {
        text: stickyCommentBody,
        thing_id: stickyID,
      }

      const updateResponse = await reddit.query({
        URL: `/api/editusertext?${stringify({ thing_id: stickyID })}`,
        method: 'POST',
        body: stringify(updateParams),
      })
      if (updateResponse.error) { console.error(updateResponse.error) }

      return true
    }
    const stickiedCommentID = await makeComment({
      sticky: true,
      content: {
        thing_id: linkID,
        text: deltaLogStickyTemplate({
          username: getCommentAuthor(comment),
          linkToPost: `/r/${deltaLogSubreddit}/comments/${deltaLogPost.wikientry.deltaLogPostID}`,
          deltaLogSubreddit,
          opawarded: awardStr,
        }),
      },
    })
    wikiPostObject.stickiedCommentID = stickiedCommentID
    await deltaLogDB.put(linkID, wikiPostObject)
    return true
  }

  /* Gets the text of a DeltaLog post, for use when updating the log */
  const loadPostText = async (deltaLogPostID) => {
    const postDetails = await reddit.query({
      URL: `/r/${deltaLogSubreddit}/comments/${deltaLogPostID}/.json`,
      method: 'GET',
    })
    if (postDetails.error) throw Error(postDetails.error)
    const postJSON = (postDetails && postDetails.json) || postDetails
    const postData = postJSON[0].data.children[0].data
    return postData.selftext
  }

  const mapDeltaLogCommentEntry = (comment, parentThing) => ({
    awardingUsername: getCommentAuthor(comment),
    awardedUsername: getCommentAuthor(parentThing),
    awardedText: formatAwardedText(parentThing.body),
    awardedLink: comment.link_url + parentThing.id,
    deltaCommentFullName: comment.name,
  })

  /* Replaces the "From OP" section contents with appropriate comment links */
  const deltaLogOPEntryTemplate = _.template(i18n[locale].deltaLogOPEntry)
  const logOpComments = (comments, postBase) => {
    const REPLACE_SECTION = '[](HTTP://DB3-FROMOP)'
    if (_.isEmpty(comments)) {
      return postBase.replace(REPLACE_SECTION, i18n[locale].deltaLogNoneYet)
    }
    return _.reduce(comments, (postSoFar, comment) => {
      const commentString = deltaLogOPEntryTemplate(comment)
      return postSoFar.replace(REPLACE_SECTION, `${commentString}\n${REPLACE_SECTION}`)
    }, postBase)
  }

  const mergeAwardingUsers = (userLinks) => {
    const initialUsers = _.dropRight(userLinks, 2)
    const finalUsers = _.takeRight(userLinks, 2)
    return initialUsers.concat(finalUsers.join(i18n[locale].andWithSpace)).join(', ')
  }

  /* Replaces the "From Other Users" section contents with appropriate comment links */
  const deltaLogOtherEntryTemplate = _.template(i18n[locale].deltaLogOtherEntry)
  const deltaLogMultipleOthersTemplate = _.template(i18n[locale].deltaLogMultipleOthers)
  const logOtherComments = (ungroupedComments, postBase) => {
    const REPLACE_SECTION = '[](HTTP://DB3-FROMOTHER)'
    if (_.isEmpty(ungroupedComments)) {
      return postBase.replace(REPLACE_SECTION, i18n[locale].deltaLogNoneYet)
    }
    const commentsGroupedById = _.groupBy(ungroupedComments,
      comment => parseCommentIdFromURL(comment.awardedLink)
    )
    return _.reduce(commentsGroupedById, (postSoFar, comments) => {
      if (comments.length === 1) {
        const comment = _.first(comments)
        const commentString = deltaLogOtherEntryTemplate(comment)
        return postSoFar.replace(REPLACE_SECTION, `${commentString}\n${REPLACE_SECTION}`)
      }

      const count = comments.length
      const users = mergeAwardingUsers(_.map(comments, comment => `/u/${comment.awardingUsername}`))
      const firstComment = _.first(comments)
      const commentsString = deltaLogMultipleOthersTemplate({
        count,
        users,
        awardedUsername: firstComment.awardedUsername,
        awardedText: firstComment.awardedText,
        awardedLink: firstComment.awardedLink,
      })
      return postSoFar.replace(REPLACE_SECTION, `${commentsString}\n${REPLACE_SECTION}`)
    }, postBase)
  }

  const groupCommentsByOp = hiddenParams => _.partition(
    hiddenParams.comments, { awardingUsername: hiddenParams.opUsername }
  )

  /* Given a JSON object like the hidden param on deltalog pages, produces the output page */
  const deltaLogContentTemplate = _.template(i18n[locale].deltaLogContent)
  const formatDeltaLogContent = (deltaLogCreationParams) => {
    const { opUsername, linkToPost } = deltaLogCreationParams
    const deltaLogBaseContent = deltaLogContentTemplate({
      opUsername,
      linkToPost,
    })
    const [commentsByOP, commentsByOther] = groupCommentsByOp(deltaLogCreationParams)
    const deltaLogContent = logOpComments(
      commentsByOP,
      logOtherComments(commentsByOther, deltaLogBaseContent)
    )
    return `${deltaLogContent}\n${stringifyObjectToBeHidden(deltaLogCreationParams)}`
  }

  const updateDeltaLogPostFromHiddenParams = async (hiddenParams, deltaLogPostID) => {
    const newDeltaLogContent = formatDeltaLogContent(hiddenParams)
    const updateParams = {
      text: newDeltaLogContent,
      thing_id: `t3_${deltaLogPostID}`,
    }
    const updateResponse = await reddit.query({
      URL: `/api/editusertext?${stringify({ thing_id: `t3_${deltaLogPostID}` })}`,
      method: 'POST',
      body: stringify(updateParams),
    })
    if (updateResponse.error) throw Error(updateResponse.error)
  }

  /* Updates a DeltaLog post, appending to the appropriate section (op/not op) */
  const addDeltaToLog = async (linkID, comment, parentThing, existingPost) => {
    const postText = await loadPostText(existingPost.deltaLogPostID)
    const deltaLogCreationParams = parseHiddenParams(postText)
    deltaLogCreationParams.comments.push(mapDeltaLogCommentEntry(comment, parentThing))
    await updateDeltaLogPostFromHiddenParams(deltaLogCreationParams, existingPost.deltaLogPostID)
    return deltaLogCreationParams
  }

  /* Makes delta log posts & updates OP/Other Users sections */
  const deltaLogSubjectTemplate = _.template(i18n[locale].deltaLogTitle)
  const findOrMakeDeltaLogPost = async (linkID, comment, parentThing) => {
    const possiblyExistingPost = await findDeltaLogPost(linkID)
    // if the log post already exists, all we'll need to do is update
    if (possiblyExistingPost != null) {
      const postContents = await addDeltaToLog(linkID, comment, parentThing, possiblyExistingPost)
      return { wikientry: possiblyExistingPost, postentry: postContents }
    }
    // otherwise, create it & add the delta details to appropriate section
    const deltaLogSubject = deltaLogSubjectTemplate(
      { title: unesc(comment.link_title) }
    )
    const deltaLogCreationParams = {
      opUsername: comment.link_author,
      linkToPost: comment.link_url,
      comments: [mapDeltaLogCommentEntry(comment, parentThing)],
    }
    const deltaLogContent = formatDeltaLogContent(deltaLogCreationParams)
    const postParams = {
      api_type: 'json',
      kind: 'self',
      sr: deltaLogSubreddit,
      text: deltaLogContent,
      title: deltaLogSubject,
    }
    const newPost = await reddit.query({
      URL: `/api/submit?${stringify(postParams)}`,
      method: 'POST',
    })
    if (newPost.error) throw Error(newPost.error)
    const postDetails = newPost.json
    const wikiPostObject = {
      originalPostID: linkID,
      originalPostURL: comment.link_url,
      deltaLogPostID: postDetails.data.id,
    }
    await deltaLogDB.put(linkID, wikiPostObject)
    await distinguishThing({ id: `t3_${postDetails.data.id}`, how: 'yes', sticky: false })
    return { wikientry: wikiPostObject, postentry: deltaLogCreationParams }
  }

  exports.verifyThenAward = async (comment) => {
    const {
      created_utc: createdUTC,
      link_id: linkID,
      link_title: linkTitle,
      link_url: linkURL,
      id,
    } = comment

    // check if DeltaBot has already replied to this comment
    const commentURL = `${linkURL}${id}.json`.replace('https://www.reddit.com', '')
    const response = await reddit.query(commentURL, true)
    const replies = _.get(response, '[1].data.children[0].data.replies')
    const dbReplied = _.reduce(_.get(replies, 'data.children'), (result, reply) => {
      if (result) return result
      return _.get(reply, 'data.author') === botUsername
    }, false)

    if (dbReplied) {
      return false
    }

    try {
      const {
        issueCount,
        parentThing,
        query,
        hiddenParams,
      } = await generateDeltaBotCommentFromDeltaCommentDEPRECATED({
        comment,
        botUsername,
        reddit,
        subreddit,
      })
      if (!query) return true
      if (issueCount === 0) {
        console.log(`${comment.name} delta comment is good! Award it!`)
        // Modify wiki for the user receiving the delta
        const flairCount = await addOrRemoveDeltaToOrFromWiki(
          {
            user: parentThing.author,
            id,
            linkTitle,
            linkURL,
            author: getCommentAuthor(comment),
            createdUTC,
            action: 'add',
            mode: 'receive',
          }
        )
        // Modify wiki for the user giving the delta
        await addOrRemoveDeltaToOrFromWiki(
          {
            user: parentThing.author,
            id,
            linkTitle,
            linkURL,
            author: getCommentAuthor(comment),
            createdUTC,
            action: 'add',
            mode: 'give',
          }
        )
        let text = i18n[locale].awardDelta
        text = text.replace(/USERNAME/g, getCommentAuthor(parentThing))
          .replace(/DELTAS/g, flairCount)
          .replace(/SUBREDDIT/g, subreddit)
        if (query.text.length) query.text += '\n\n'
        query.text += text
        await updateFlair({ name: parentThing.author, flairCount })
        await sendIntroductoryMessage({ username: parentThing.author, flairCount })
      }
      query.text += `${i18n[locale].global}\n${stringifyObjectToBeHidden(hiddenParams)}`
      await makeComment({ content: query, sticky: false })
      if (issueCount === 0 && deltaLogEnabled) {
        const deltaLogPost = await findOrMakeDeltaLogPost(linkID, comment, parentThing)
        await findOrMakeStickiedComment(linkID, comment, deltaLogPost)
      }
    } catch (err) {
      console.log(err)
    }
    return true
  }

  const checkMessagesforDeltas = async () => {
    last[1] = Date.now()
    try {
      console.log('Making unread messages call!')
      const unreadInboxResponse = await reddit.query('/message/unread')
      console.log('Got unread messages call!')
      if (unreadInboxResponse.error) throw Error(unreadInboxResponse.error)
      const comments = (
        _(unreadInboxResponse)
          .get('data.children')
          .reduce((result, obj) => {
            if (obj.data.subject.toLowerCase() === 'add') {
              const commentLinks = (
                _.get(obj, 'data.body')
                  .match(new RegExp(`/r/${subreddit}/comments/[^()[\\]& \n]+`, 'g'))
              )
              const fullName = _.get(obj, 'data.name')
              result.names.push(fullName)
              result.commentLinks = result.commentLinks.concat(commentLinks)
              return result
            }
            return result
          }, { names: [], commentLinks: [] })
      )
      const deleteCommentLinks = (
        _(unreadInboxResponse)
          .get('data.children')
          .reduce((result, obj) => {
            if (obj.data.subject.toLowerCase() === 'delete') {
              const commentLinks = (
                _.get(obj, 'data.body')
                  .match(new RegExp(`/r/${subreddit}/comments/[^()[\\]& \n]+`, 'g'))
              )
              const fullName = _.get(obj, 'data.name')
              result.names.push(fullName)
              result.commentLinks = result.commentLinks.concat(commentLinks)
              return result
            }
            return result
          }, { names: [], commentLinks: [] })
      )
      if (deleteCommentLinks.commentLinks.length) {
        deleteCommentLinks.commentLinks = _.uniq(deleteCommentLinks.commentLinks)
        const getParentUserName = async ({ parent_id: parentId }) => {
          const parentComment = await reddit.query(
            `/r/${subreddit}/api/info?${stringify({ id: parentId })}`
          )
          return _.get(parentComment, 'data.children[0].data.author')
        }
        for (let i = 0; i < deleteCommentLinks.commentLinks.length; i += 1) {
          /* eslint-disable no-await-in-loop */
          try {
            const commentLink = deleteCommentLinks.commentLinks[i].replace(/\/\?context=[\d]+$/i, '')
            const response = await reddit.query(`${commentLink}`)
            const {
              replies,
              link_id,
              author,
              body,
              body_html,
              edited,
              parent_id,
              id,
              name,
              author_flair_text,
              created_utc,
              created,
            } = _.get(response, '[1].data.children[0].data')
            const { title: link_title, url: link_url } = _.get(response, '[0].data.children[0].data')
            const comment = {
              link_title,
              link_id,
              author,
              body,
              body_html,
              edited,
              parent_id,
              id,
              name,
              author_flair_text,
              link_url,
              created_utc,
              created,
            }
            const dbReply = getDeltaBotReply(botUsername, replies)
            if (dbReply) {
              const hiddenParams = parseHiddenParams(dbReply.body)
              if (_.keys(hiddenParams.issues).length === 0) { // check if it was a valid delta
                const parentUserName = (
                  hiddenParams.parentUserName ||
                  await getParentUserName(comment)
                )
                const flairCount = await addOrRemoveDeltaToOrFromWiki(
                  {
                    user: parentUserName,
                    id: comment.id,
                    action: 'remove',
                    mode: 'receive',
                  }
                )
                await updateFlair({ name: parentUserName, flairCount })
                await addOrRemoveDeltaToOrFromWiki(
                  {
                    author: comment.author,
                    id: comment.id,
                    action: 'remove',
                    mode: 'give',
                  }
                )
                // if Delta Log is enabled, delete stuff related to that
                if (deltaLogEnabled) {
                  // grab the relevant info from the comment
                  const { link_id: linkId, name: deltaCommentName } = comment

                  // find the deltaLog JSON related to the comment
                  const deltaLogPostDataJson = await findDeltaLogPost(linkId)
                  if (deltaLogPostDataJson) {
                    // get the hidden parameters from the post
                    // first, get the post text
                    const postText = await loadPostText(deltaLogPostDataJson.deltaLogPostID)
                    // then, parse the hidden parameters from the post text
                    const postTextHiddenParams = parseHiddenParams(postText)

                    // generate new hidden parameters with the comment data removed
                    const newPostTextHiddenParams = _.cloneDeep(postTextHiddenParams)
                    newPostTextHiddenParams.comments = _.reject(
                      postTextHiddenParams.comments, { deltaCommentFullName: deltaCommentName }
                    )

                    // get arrays of comments from OP and comments
                    const [commentsByOP] = groupCommentsByOp(newPostTextHiddenParams)

                    // delete the sticky comment if there are no comments by OP
                    if (commentsByOP.length === 0 && 'stickiedCommentID' in deltaLogPostDataJson) {
                      await reddit.query({
                        URL: '/api/del',
                        method: 'POST',
                        body: stringify({ id: deltaLogPostDataJson.stickiedCommentID }),
                      })
                      delete deltaLogPostDataJson.stickiedCommentID
                    }

                    console.log(newPostTextHiddenParams)
                    if (_.get(newPostTextHiddenParams, 'comments.length') === 0) {
                      // if there are no comments, delete the whole post
                      await reddit.query({
                        URL: '/api/del',
                        method: 'POST',
                        body: stringify({ id: `t3_${deltaLogPostDataJson.deltaLogPostID}` }),
                      })

                      // delete the post from the delta log database
                      await deltaLogDB.del(linkId)
                    } else {
                      // if there are comments, update it
                      updateDeltaLogPostFromHiddenParams(
                        newPostTextHiddenParams,
                        deltaLogPostDataJson.deltaLogPostID
                      )
                    }
                  }
                }
              }
              // Delete the comment
              await reddit.query({
                URL: '/api/del',
                method: 'POST',
                body: stringify({ id: dbReply.name }),
              })
            }
          } catch (err) {
            console.error(err)
          }
          /* eslint-enable no-await-in-loop */
        }
      }
      if (comments.commentLinks.length) {
        comments.commentLinks = _.uniq(comments.commentLinks)
        try {
          for (let i = 0; i < comments.commentLinks.length; i += 1) {
            /* eslint-disable no-await-in-loop */
            const commentLink = comments.commentLinks[i]
            const response = await reddit.query(`${commentLink}`)
            const {
              link_id,
              author,
              body,
              body_html,
              edited,
              parent_id,
              id,
              name,
              author_flair_text,
              created_utc,
              created,
            } = _.get(response, '[1].data.children[0].data')
            const {
              author: link_author,
              title: link_title,
              url: link_url,
            } = _.get(response, '[0].data.children[0].data')
            const comment = {
              link_title,
              link_id,
              link_author,
              author,
              body,
              body_html,
              edited,
              parent_id,
              id,
              name,
              author_flair_text,
              link_url,
              created_utc,
              created,
            }
            if (checkCommentForDelta(comment)) {
              await exports.verifyThenAward(comment)
            }
            /* eslint-enable no-await-in-loop */
          }
        } catch (err) {
          console.error(err)
        }
      }
      if (comments.commentLinks.length || deleteCommentLinks.commentLinks.length) {
        const read = await reddit.query(
          {
            URL: '/api/read_message',
            method: 'POST',
            body: stringify(
              {
                id: JSON.stringify(
                  [].concat(
                    comments.names, deleteCommentLinks.names
                  )
                ).replace(/"|\[|]/g, ''),
              }
            ),
          }
        )
        if (read.error) throw Error(read.error)
      }
    } catch (err) {
      console.log('Error!'.red)
      console.error(err)
    }
    setTimeout(checkMessagesforDeltas, 30000)
  }

  try {
    await reddit.connect()
    console.log('Start loading modules!'.bgGreen.cyan)

    // begin loading modules
    const Modules = require('./modules')
    await _.each(Modules, async (Module, name) => {
      try {
        console.log(`Trying to load ${name} module!`.bgCyan)
        const module = new Module(reddit)
        await module.bootstrap()
      } catch (err) {
        console.error(`${err.stack}`.bgRed)
      }
      console.log(`Done trying to load ${name} module!`.bgCyan)
    }, {})
    console.log('Finished loading modules!'.bgGreen.cyan)

    checkMessagesforDeltas()
  } catch (err) {
    console.error(err)
  }
  try {
    let deltaBoardsCredentials
    /* eslint-disable import/no-unresolved */
    try {
      deltaBoardsCredentials = require(
        path.resolve('./config/credentials/delta-boards-credentials.json')
      )
    } catch (err) {
      console.log('Missing credentials for delta-boards! Using base creds as fallback!'.red)
      deltaBoardsCredentials = require(path.resolve('./config/credentials/credentials.json'))
    }
    /* eslint-enable import/no-unresolved */
    const deltaBoards = new DeltaBoards({
      subreddit,
      credentials: deltaBoardsCredentials,
      version: packageJson.version,
      flags,
    })
    deltaBoards.initialStart()
  } catch (err) {
    console.error(err)
  }
})()
