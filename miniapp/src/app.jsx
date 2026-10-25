import Editor from './features/editor/editor.jsx'
import useJob from './features/job/use-job.js'

export default function App() {
  const {job, notice} = useJob()
  return <Editor key={job?.id ?? 'empty'} job={job} notice={notice}/>
}
