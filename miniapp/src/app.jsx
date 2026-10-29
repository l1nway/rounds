import Editor from './features/editor/editor.jsx'
import useJob from './features/job/use-job.js'
import {postRender} from './services/api.js'
import {close} from './services/telegram.js'

const send = async (job, body) => {
  await postRender(job.id, body)
  close()
}

export default function App() {
  const {job, notice} = useJob()
  return <Editor job={job} notice={notice} send={send}/>
}
