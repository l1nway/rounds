import Editor from './features/editor/editor.jsx'
import useJob from './features/job/use-job.js'

export default function App() {
  const {job, notice} = useJob()
  return <Editor job={job} notice={notice}/>
}
