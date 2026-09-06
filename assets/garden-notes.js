(() => {
  document.querySelectorAll('.garden-body a[href^="http://"], .garden-body a[href^="https://"]').forEach(link => {
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  })
  const list = document.querySelector('.garden-page-list')
  const input = document.querySelector('#garden-search')
  const count = document.querySelector('#garden-search-count')
  if (!list || !input) return
  const buttons = [...document.querySelectorAll('[data-garden-sort]')]
  let records = new Map()
  const apply = () => {
    const query = input.value.trim().toLocaleLowerCase('ja')
    let shown = 0
    list.querySelectorAll('article').forEach(item => {
      const record = records.get(item.dataset.pageId)
      const visible = !query || `${record?.title || ''} ${record?.text || ''}`.toLocaleLowerCase('ja').includes(query)
      item.hidden = !visible
      if (visible) shown += 1
    })
    if (count) count.textContent = String(shown)
  }
  const sort = mode => {
    const items = [...list.querySelectorAll('article')]
    items.sort((a, b) => mode === 'linked' ? Number(b.dataset.connections) - Number(a.dataset.connections) || b.dataset.updated.localeCompare(a.dataset.updated) : b.dataset.updated.localeCompare(a.dataset.updated))
    items.forEach(item => list.appendChild(item))
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.gardenSort === mode)))
  }
  buttons.forEach(button => button.addEventListener('click', () => sort(button.dataset.gardenSort)))
  input.addEventListener('input', apply)
  fetch('/garden/search.json').then(response => response.json()).then(items => { records = new Map(items.map(item => [item.id, item])); sort('linked'); apply() })
})()
