/**
 * Client-side interactivity for Visual CI Dashboard:
 * - Real-time filtering by status toggle buttons (All, Passed, Approved, Failed; aria-pressed)
 * - Search bar filter (Run ID, branch, commit)
 * - Client-side table pagination
 *
 * Loaded as a module (deferred), so the DOM is already parsed when this runs.
 */

function initDashboard() {
  const table = document.getElementById('test-runs-table');
  if (!table) return;

  const rows = Array.from(table.querySelectorAll('tbody tr[data-run-id]'));
  const filterTabs = document.querySelectorAll('.filter-tab');
  const searchInput = document.getElementById('dashboard-search');
  const prevBtn = document.getElementById('prev-page-btn');
  const nextBtn = document.getElementById('next-page-btn');
  const pageInfo = document.getElementById('pagination-info');
  const showingRange = document.getElementById('showing-range');

  const PAGE_SIZE = 10;
  let currentPage = 1;
  let currentFilter = 'all';
  let searchQuery = '';

  function getFilteredRows() {
    return rows.filter((row) => {
      const status = row.getAttribute('data-status') || '';
      const runId = row.getAttribute('data-run-id') || '';
      const branch = row.getAttribute('data-branch') || '';
      const commit = row.getAttribute('data-commit') || '';

      // Status filter
      let matchesStatus = true;
      if (currentFilter === 'passed') {
        matchesStatus = status === 'PASSED';
      } else if (currentFilter === 'approved') {
        matchesStatus = status === 'APPROVED';
      } else if (currentFilter === 'failed') {
        matchesStatus = status === 'FAILED' || status === 'REJECTED';
      }

      // Search query filter
      let matchesSearch = true;
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        matchesSearch = runId.toLowerCase().includes(query) ||
                        branch.toLowerCase().includes(query) ||
                        commit.toLowerCase().includes(query);
      }

      return matchesStatus && matchesSearch;
    });
  }

  function updateTable() {
    const filtered = getFilteredRows();
    const totalFiltered = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE));

    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    const startIdx = (currentPage - 1) * PAGE_SIZE;
    const endIdx = startIdx + PAGE_SIZE;

    rows.forEach((row) => {
      row.style.display = 'none';
    });

    const visibleRows = filtered.slice(startIdx, endIdx);
    visibleRows.forEach((row) => {
      row.style.display = '';
    });

    // Update pagination labels
    if (pageInfo) {
      pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
    }
    if (showingRange) {
      if (totalFiltered === 0) {
        showingRange.textContent = 'Showing 0 runs';
      } else {
        showingRange.textContent = `Showing ${startIdx + 1}–${Math.min(endIdx, totalFiltered)} of ${totalFiltered} run${totalFiltered === 1 ? '' : 's'}`;
      }
    }

    if (prevBtn) prevBtn.disabled = currentPage <= 1;
    if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
  }

  // Filter buttons: toggle buttons (aria-pressed), exactly one pressed at a time
  filterTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      filterTabs.forEach((t) => {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-pressed', String(t === tab));
      });
      currentFilter = tab.getAttribute('data-filter');
      currentPage = 1;
      updateTable();
    });
  });

  // Search input change
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      currentPage = 1;
      updateTable();
    });
  }

  // Prev / Next buttons
  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      if (currentPage > 1) {
        currentPage--;
        updateTable();
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      const filtered = getFilteredRows();
      const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
      if (currentPage < totalPages) {
        currentPage++;
        updateTable();
      }
    });
  }

  // Initial render
  updateTable();
}

initDashboard();
