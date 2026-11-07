import Editor from './features/editor/editor.jsx'
import useJob, {sendRender} from './features/job/use-job.js'

export default function App() {
  const {job, notice, gate} = useJob()
  return <Editor job={job} notice={notice} send={sendRender} gate={gate}/>
}
