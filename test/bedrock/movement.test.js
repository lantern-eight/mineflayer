/* eslint-env mocha */
// Offline test for the Bedrock movement controls in client_input: setControlState records intent, the per-tick
// player_auth_input carries the matching local-frame move_vector and input flags (and serializes), and a
// correct_player_move_prediction applies the server's authoritative position to bot.entity. Server-authoritative
// movement itself is verified live; this guards the packet the client sends and the correction it applies.
const assert = require('assert')
const { EventEmitter } = require('events')
const Vec3 = require('vec3')
const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
const registryLoader = require('prismarine-registry')
const injectInput = require('../../lib/bedrock_plugins/client_input')
const { bedrockTestedVersions } = require('../../lib/version')

// A bot whose physics engine runs, so each send steps it: it needs a Vec3 position, an inventory and a world.
function makeWalkingBot (version) {
  const bot = new EventEmitter()
  bot.registry = registryLoader('bedrock_' + version)
  bot._client = new EventEmitter()
  bot._client.queue = () => {}
  bot.entity = { position: new Vec3(0, 64, 0), eyeHeight: 1.62, yaw: 0, pitch: 0 }
  bot.inventory = { slots: [] }
  bot.blockAt = () => null
  injectInput(bot)
  return bot
}

// How many physics steps the next send makes. A send makes all of its steps at once, so they are counted until the
// event loop moves on.
function stepsOfNextSend (bot) {
  return new Promise(resolve => {
    let steps = 0
    const onTick = () => {
      if (steps++ === 0) setImmediate(() => { bot.removeListener('physicsTick', onTick); resolve(steps) })
    }
    bot.on('physicsTick', onTick)
  })
}

function makeBot (version) {
  const bot = new EventEmitter()
  bot.registry = registryLoader('bedrock_' + version)
  const sent = []
  bot._client = new EventEmitter()
  bot._client.queue = (name, params) => sent.push({ name, params })
  bot.entity = { position: { x: 0, y: 64, z: 0 }, eyeHeight: 1.62, yaw: 0, pitch: 0 }
  injectInput(bot)
  return { bot, sent }
}

for (const version of bedrockTestedVersions) {
  describe(`bedrock ${version} movement controls`, function () {
    const serializer = createSerializer(version)

    afterEach(function () { /* timers are unref'd; nothing to clean */ })

    it('setControlState / getControlState / clearControlStates and unknown control throws', function () {
      const { bot } = makeBot(version)
      assert.strictEqual(bot.getControlState('forward'), false)
      bot.setControlState('forward', true)
      assert.strictEqual(bot.getControlState('forward'), true)
      bot.clearControlStates()
      assert.strictEqual(bot.getControlState('forward'), false)
      assert.throws(() => bot.setControlState('teleport', true))
    })

    it('clearControlStates lets go of each key through bot.setControlState, as on Java', function () {
      const { bot } = makeBot(version)
      bot.setControlState('forward', true)
      bot.setControlState('sprint', true)
      const original = bot.setControlState
      const calls = []
      // A wrapper that ignores every call, as a plugin does for a task it has stopped: nothing is let go.
      bot.setControlState = (control, state) => { calls.push([control, state]) }
      bot.clearControlStates()
      assert.deepStrictEqual(calls.map(([control]) => control).sort(), ['back', 'forward', 'jump', 'left', 'right', 'sneak', 'sprint'])
      assert.ok(calls.every(([, state]) => state === false))
      assert.strictEqual(bot.getControlState('forward'), true, 'the wrapper decides, not a direct write')
      bot.setControlState = original
      bot.clearControlStates()
      assert.strictEqual(bot.getControlState('forward'), false)
      assert.strictEqual(bot.getControlState('sprint'), false)
    })

    it('the auth-input tick carries the move_vector and input flags for the active controls, and serializes', function () {
      const { bot, sent } = makeBot(version)
      bot.setControlState('forward', true)
      bot.setControlState('sprint', true)
      bot.emit('spawn') // starts the input loop; send() runs once synchronously
      const pkt = sent.find(p => p.name === 'player_auth_input')
      assert.ok(pkt, 'a player_auth_input is sent')
      assert.deepStrictEqual(pkt.params.move_vector, { x: 0, z: 1 }, 'forward is +z in the local frame')
      const flags = Array.isArray(pkt.params.input_data) ? pkt.params.input_data : Object.keys(pkt.params.input_data).filter(k => pkt.params.input_data[k])
      assert.ok(flags.includes('up'), 'forward sets the up flag')
      assert.ok(flags.includes('sprinting'), 'sprint sets the sprinting flag')
      assert.doesNotThrow(() => serializer.createPacketBuffer(pkt), 'player_auth_input must serialize')
      bot._client.emit('close')
    })

    it('a flag queued for the next tick goes out with it once, and serializes', function () {
      // start_using_item marks the tick a player starts eating or drinking; it is a press, not a held state.
      const { bot, sent } = makeBot(version)
      bot._queueInputFlag('start_using_item')
      bot.emit('spawn') // starts the input loop; send() runs once synchronously
      const flagsOf = (pkt) => Array.isArray(pkt.params.input_data) ? pkt.params.input_data : Object.keys(pkt.params.input_data).filter(k => pkt.params.input_data[k])
      const first = sent.filter(p => p.name === 'player_auth_input')
      assert.ok(first.length >= 1)
      assert.ok(flagsOf(first[0]).includes('start_using_item'), 'the first tick carries the flag')
      assert.doesNotThrow(() => serializer.createPacketBuffer(first[0]), 'player_auth_input must serialize')
      return new Promise(resolve => setTimeout(resolve, 150)).then(() => {
        const later = sent.filter(p => p.name === 'player_auth_input').slice(1)
        assert.ok(later.length >= 1, 'later ticks were sent')
        for (const pkt of later) assert.ok(!flagsOf(pkt).includes('start_using_item'), 'only once')
        bot._client.emit('close')
      })
    })

    it('applies correct_player_move_prediction to bot.entity.position (feet from eye level)', function () {
      const { bot } = makeBot(version)
      bot._client.emit('correct_player_move_prediction', { position: { x: 10, y: 65.62, z: -4 } })
      assert.strictEqual(bot.entity.position.x, 10)
      assert.ok(Math.abs(bot.entity.position.y - 64) < 1e-6, 'feet = eye - eyeHeight')
      assert.strictEqual(bot.entity.position.z, -4)
    })

    it('a bot that is not steering takes even a small correction in full', function () {
      // As when the pathfinder's fullStop() moves the position to the middle of a block: the server does not follow,
      // and says so. Taking only Y left the bot over a hole it was not in, falling and being put back up for good.
      // Seen live on a Bedrock Dedicated Server 1.26.63.
      const { bot } = makeBot(version)
      bot._client.emit('correct_player_move_prediction', { position: { x: 0.4, y: 65.62, z: -0.2 } })
      assert.strictEqual(bot.entity.position.x, 0.4)
      assert.strictEqual(bot.entity.position.z, -0.2)
    })

    it('a bot that is steering keeps its own place against a small correction', function () {
      // The correction is for a tick in the past and the bot has walked on since; only its height is taken.
      const { bot } = makeBot(version)
      bot.setControlState('forward', true)
      bot._client.emit('correct_player_move_prediction', { position: { x: 0.4, y: 66.62, z: 0 } })
      assert.strictEqual(bot.entity.position.x, 0)
      assert.ok(Math.abs(bot.entity.position.y - 65) < 1e-6)
      // A large one is the server moving the bot, steering or not.
      bot._client.emit('correct_player_move_prediction', { position: { x: 3, y: 66.62, z: 0 } })
      assert.strictEqual(bot.entity.position.x, 3)
      bot._client.emit('close')
    })

    it('fires move, with the place before, on each tick the bot moved or turned, and not when it stood still', async function () {
      // As mineflayer does on Java. Before, move fired only on a server correction or a teleport: a walk of sixteen blocks
      // brought three of them, some five blocks apart. Seen live on a Bedrock Dedicated Server 1.26.60.
      const { bot, sent } = makeBot(version) // no physics steps: only what the test changes moves the bot
      const nextSend = () => new Promise(resolve => {
        const count = sent.length
        const check = setInterval(() => { if (sent.length > count) { clearInterval(check); resolve() } }, 5)
      })
      const moves = []
      bot.on('move', from => moves.push({ from: { ...from }, to: { ...bot.entity.position } }))
      bot.emit('spawn') // the first send runs at once and reports where the bot is
      assert.strictEqual(moves.length, 1)

      bot.entity.position.x = 1 // moved since the last send
      await nextSend()
      assert.strictEqual(moves.length, 2)
      assert.strictEqual(moves[1].from.x, 0, 'the place before the move')
      assert.strictEqual(moves[1].to.x, 1)

      bot.entity.yaw = 1 // turned only
      await nextSend()
      assert.strictEqual(moves.length, 3)

      await nextSend() // stood still
      await nextSend()
      assert.strictEqual(moves.length, 3, 'nothing to report')

      // A correction fires move itself; the next send does not announce it again.
      bot._client.emit('correct_player_move_prediction', { position: { x: 5, y: 65.62, z: 0 } })
      assert.strictEqual(moves.length, 4)
      await nextSend()
      assert.strictEqual(moves.length, 4)
      bot._client.emit('close')
    })

    it('after the event loop stalls, a send makes up no more than two ticks of movement', async function () {
      // The server got no input while the loop was busy and kept the player still. Making up every missed tick at once
      // (up to 8) put a walking bot a block or more ahead of it; the server pulled the bot back a second later, after
      // mineflayer-pathfinder had already counted its goal as reached. Seen live on a Bedrock Dedicated Server 1.26.63.
      const bot = makeWalkingBot(version)
      bot.setControlState('forward', true)
      bot.emit('spawn') // the first send runs at once
      const realNow = Date.now
      Date.now = () => realNow() + 600 // twelve ticks go by before the next send
      try {
        assert.strictEqual(await stepsOfNextSend(bot), 2)
      } finally {
        Date.now = realNow
        bot._client.emit('close')
      }
    })
  })
}
