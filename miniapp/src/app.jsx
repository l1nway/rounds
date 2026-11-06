import {lazy, Suspense} from 'react'
import Editor from './features/editor/editor.jsx'
import useJob from './features/job/use-job.js'
import {postRender} from './services/api.js'
import {close} from './services/telegram.js'

const Check = lazy(() => import('./features/check/check.jsx'))

const send = async (job, body) => {
  await postRender(job.id, body)
  close()
}

export default function App() {
  const {job, notice} = useJob()
  return (
    <>
      <Editor job={job} notice={notice} send={send}/>
      {job?.tier === 'pro' && <Suspense fallback={null}><Check job={job}/></Suspense>}
    </>
  )
}
