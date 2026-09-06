(() => {
  const list = document.querySelector('.garden-page-list')
  const input = document.querySelector('#garden-search')
  const count = document.querySelector('#garden-search-count')
  if (!list || !input) return
  const sortButtons = [...document.querySelectorAll('[data-garden-sort]')]
  const filterButtons = [...document.querySelectorAll('[data-garden-filter]')]
  let records = new Map()
  let sortMode = 'linked'
  let filterMode = 'all'

  const apply = () => {
    const query = input.value.trim().toLocaleLowerCase('ja')
    const hub = [...records.values()].find(record => record.publicId === filterMode)
    let shown = 0
    list.querySelectorAll('article').forEach(item => {
      const record = records.get(item.dataset.pageId)
      const matchesText = !query || `${record?.title || ''} ${record?.text || ''}`.toLocaleLowerCase('ja').includes(query)
      const matchesFilter = filterMode === 'all' || Boolean(hub && record?.id !== hub.id && record?.relations?.includes(hub.id))
      item.hidden = !(matchesText && matchesFilter)
      if (!item.hidden) shown += 1
    })
    if (count) count.textContent = `${shown}`
  }

  const sort = mode => {
    sortMode = mode
    const items = [...list.querySelectorAll('article')]
    items.sort((a, b) => sortMode === 'linked'
      ? Number(b.dataset.connections) - Number(a.dataset.connections) || b.dataset.updated.localeCompare(a.dataset.updated)
      : b.dataset.updated.localeCompare(a.dataset.updated))
    items.forEach(item => list.appendChild(item))
    sortButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.gardenSort === sortMode)))
  }

  sortButtons.forEach(button => button.addEventListener('click', () => sort(button.dataset.gardenSort)))
  filterButtons.forEach(button => button.addEventListener('click', () => {
    filterMode = button.dataset.gardenFilter
    filterButtons.forEach(candidate => candidate.setAttribute('aria-pressed', String(candidate === button)))
    apply()
  }))
  input.addEventListener('input', apply)
  fetch('/garden-index.json').then(response => response.json()).then(items => {
    records = new Map(items.map(item => [item.id, item]))
    sort('linked')
    apply()
  })
})()
