const parseLinkHeader = require('parse-link-header')
const axios = require('axios')

const { isReleaseOlderThanDays } = require('./is-release-older-than-days')
const { isReleaseAssociatedWithProject } = require('./is-release-associated-with-project')

require('dotenv').config()

const {
  SENTRY_BASE_URL,
  SENTRY_PORT,
  SENTRY_TOKEN,
  SENTRY_ORGANIZATION,
  SENTRY_PROJECT,
  SENTRY_DAYS_TO_KEEP,
} = process.env

const sentryUrl = SENTRY_PORT ? `${SENTRY_BASE_URL}:${SENTRY_PORT}` : SENTRY_BASE_URL

function verifyEnvironmentVariables() {
  return !!SENTRY_BASE_URL
    && !!SENTRY_TOKEN
    && !!SENTRY_ORGANIZATION
    && !!SENTRY_DAYS_TO_KEEP
}

async function getReleaseFromServerPaginated(paginatedUrl) {
  const options = {
    headers: {
      Authorization: `Bearer ${SENTRY_TOKEN}`,
    },
  }
  console.log('fetching url', paginatedUrl) // eslint-disable-line no-console
  const res = await axios.get(paginatedUrl, options)
  const { data, status } = res
  const contentType = res.headers['content-type']

  if (status !== 200) {
    throw new Error(`Request Failed. Status Code: ${status}`)
  } else if (!/^application\/json/.test(contentType)) {
    throw new Error('Invalid content-type.\n' +
      `Expected application/json but received ${contentType}`)
  }

  let linkHeader
  if (SENTRY_PORT) {
    linkHeader = parseLinkHeader(res.headers.link.replace(/.com/g, `.com:${SENTRY_PORT}`))
  } else {
    linkHeader = parseLinkHeader(res.headers.link)
  }

  return {
    linkHeader,
    data,
  }
}

async function getAllReleasesFromServer() {
  let morePagesAvailable = true
  let paginatedUrl = `${sentryUrl}/api/0/organizations/${SENTRY_ORGANIZATION}/releases/`
  let allData = []

  while (morePagesAvailable) {
    // We have to fetch pages one by one
    // eslint-disable-next-line no-await-in-loop
    const { data, linkHeader } = await getReleaseFromServerPaginated(paginatedUrl)

    allData = allData.concat(data)

    // the parsedHeader contains strings only
    morePagesAvailable = (linkHeader.next.results === 'true')
    paginatedUrl = linkHeader.next.url
  }

  return allData
}

function getReleaseVersion(release) {
  return release.version
}

async function deleteReleaseVersionFromServer(releaseVersion) {
  const endpoint = `${sentryUrl}/api/0/organizations/${SENTRY_ORGANIZATION}/releases/${releaseVersion}/`

  const options = {
    headers: {
      Authorization: `Bearer ${SENTRY_TOKEN}`,
    },
  }

  console.log(`Deleting ${releaseVersion} ...`) // eslint-disable-line no-console
  await axios.delete(endpoint, options)
  console.log('Done.') // eslint-disable-line no-console
}

async function deleteReleasesOlderThanDays(dryRun) {
  if (!verifyEnvironmentVariables()) {
    throw new Error('Environment variables not set correctly.')
  }

  const releases = await getAllReleasesFromServer()
  console.log('found', releases.length, 'releases') // eslint-disable-line no-console

  let releaseVersionsToDelete
  if (SENTRY_PROJECT) {
    releaseVersionsToDelete = releases
      .filter(release => isReleaseAssociatedWithProject(SENTRY_PROJECT, release))
      .filter(release => isReleaseOlderThanDays(SENTRY_DAYS_TO_KEEP, release))
      .map(getReleaseVersion)
  } else {
    releaseVersionsToDelete = releases
      .filter(release => isReleaseOlderThanDays(SENTRY_DAYS_TO_KEEP, release))
      .map(getReleaseVersion)
  }

  if (releaseVersionsToDelete.length === 0) {
    console.log(`No releases older than ${SENTRY_DAYS_TO_KEEP} days${SENTRY_PROJECT ? ` for project "${SENTRY_PROJECT}"` : ''} found.`) // eslint-disable-line no-console
    return
  }
  console.log(`Found ${releaseVersionsToDelete.length} release versions to delete.`) // eslint-disable-line no-console

  if (!dryRun) {
    const errors = []
    for (let i = 0; i < releaseVersionsToDelete.length; i += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await deleteReleaseVersionFromServer(releaseVersionsToDelete[i])
      } catch (error) {
        console.log('Error.') // eslint-disable-line no-console
        errors.push(error)
      }
    }
    console.log('-----------------------------------------') // eslint-disable-line no-console
    const deletedReleases = releaseVersionsToDelete.length - errors.length
    console.log(`Deleted ${deletedReleases} releases. ${errors.length} releases were not deleted because the Sentry server rejected the request. Reasons:`) // eslint-disable-line no-console
    errors.forEach((error) => {
      console.log(`* ${error.response.data.detail}`) // eslint-disable-line no-console
    })
  } else {
    console.log('-----------------------------------------') // eslint-disable-line no-console
    console.log('Nothing deleted since this was a dry run.') // eslint-disable-line no-console
  }
}

module.exports = {
  deleteReleasesOlderThanDays,
}
