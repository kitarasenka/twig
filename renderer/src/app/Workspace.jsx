import { useRef, useState } from 'react';
import { GitBranch, PanelRightOpen, Search } from 'lucide-react';
import DemoGraph from '../features/graph/DemoGraph.jsx';
import Button from '../ui/Button.jsx';
import Splitter from '../ui/Splitter.jsx';
import { Sidebar, CommitDetails } from './Panels.jsx';
import { PANEL_DEFAULT } from '../ui/panel-width.js';
import { commits } from './demo.js';

export default function Workspace({ filterRef, mod, sidebar, onSidebar, searchSignal }) {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(commits[0].id);
  const [detail, setDetail] = useState(true);
  const [width, setWidth] = useState(PANEL_DEFAULT);
  const scroll = useRef(0);
  return <div className={`workspace ${sidebar ? 'sidebar-small' : ''} ${detail ? '' : 'no-detail'}`} style={{ '--detail-width': `${width}px` }}>
    <Sidebar collapsed={sidebar} onCollapse={onSidebar} filter={filter} onFilter={setFilter} filterRef={filterRef} mod={mod} />
    <main className="graph-panel" aria-label="History">
      <header className="graph-heading"><div><GitBranch /><strong>History</strong><span className="count">{commits.length}</span></div>
        <div><span className="muted">All branches</span>{!detail && <Button icon={PanelRightOpen} aria-label="Show commit details" onClick={() => setDetail(true)} />}
          <Button icon={Search} aria-label="Search history" title={`${mod}+F`} onClick={searchSignal} /></div></header>
      <div className="demo-notice" id="demo-notice"><span className="demo-pill">PREVIEW</span><span>Sample repository. Explore the layout; no Git commands are run.</span></div>
      <DemoGraph selected={selected} onSelect={(id) => { setSelected(id); setDetail(true); }} filter={filter} scroll={scroll.current} onScroll={(value) => { scroll.current = value; }} />
    </main>
    {detail && <Splitter width={width} onWidth={setWidth} />}
    {detail && <CommitDetails selected={selected} onSelect={setSelected} onClose={() => setDetail(false)} />}
  </div>;
}
