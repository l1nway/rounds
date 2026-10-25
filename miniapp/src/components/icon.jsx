const PATHS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
  previous: 'M6 6h2v12H6zm3.5 6 8.5 6V6z',
  next: 'M16 6h2v12h-2zM6 18l8.5-6L6 6z',
  clear: 'M18.3 5.7 12 12l6.3 6.3-1.4 1.4-6.3-6.3-6.3 6.3-1.4-1.4 6.3-6.3-6.3-6.3 1.4-1.4 6.3 6.3 6.3-6.3z',
  exclude: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm5 11H7v-2h10z'
}

export default function Icon({name}) {
  return <svg viewBox='0 0 24 24' aria-hidden='true'><path d={PATHS[name]}/></svg>
}
