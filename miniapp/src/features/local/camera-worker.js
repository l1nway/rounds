import {solve} from './camera.js'

// [DOC: camera-worker]
self.onmessage = async ({data}) => {
  try {
    self.postMessage({path: await solve(...data)})
  } catch (error) {
    self.postMessage({error: error.message})
  }
}
