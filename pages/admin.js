import { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import toast, { Toaster } from 'react-hot-toast';
import { useSession, signOut } from 'next-auth/react';
import { useRouter } from 'next/router';
import jsPDF from 'jspdf';
import 'jspdf-autotable';
import {
  LayoutDashboard, Package, Receipt, ClipboardList, Settings,
  LogOut, Trash2, UploadCloud, FileSpreadsheet, Fingerprint,
  ArrowRight, Search, Filter, RefreshCw, Printer, Download,
  CheckCircle, XCircle, Clock, AlertCircle, ChevronLeft, ChevronRight,
  Phone, DollarSign, TrendingUp, ShieldCheck, Eye, EyeOff, Send,
  BarChart2, X, Check, Edit3, Save
} from 'lucide-react';

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'vouchers', label: 'Vouchers', icon: Package },
  { id: 'transactions', label: 'Transactions', icon: Receipt },
  { id: 'preorders', label: 'Pre-Orders', icon: ClipboardList },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const TYPES = ['WASSCE', 'BECE', 'CSSPS'];
const STATUSES = ['available', 'sold', 'used'];

const StatusBadge = ({ status }) => {
  const map = {
    available: { color: 'bg-emerald-100 text-emerald-700 border-emerald-200', icon: CheckCircle },
    sold: { color: 'bg-blue-100 text-blue-700 border-blue-200', icon: DollarSign },
    used: { color: 'bg-gray-100 text-gray-600 border-gray-200', icon: CheckCircle },
    success: { color: 'bg-emerald-100 text-emerald-700 border-emerald-200', icon: CheckCircle },
    pending: { color: 'bg-amber-100 text-amber-700 border-amber-200', icon: Clock },
    fulfilled: { color: 'bg-blue-100 text-blue-700 border-blue-200', icon: CheckCircle },
    preorder: { color: 'bg-violet-100 text-violet-700 border-violet-200', icon: Clock },
  };
  const cfg = map[status] || { color: 'bg-gray-100 text-gray-500 border-gray-200', icon: AlertCircle };
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest border ${cfg.color}`}>
      <Icon size={10} /> {status}
    </span>
  );
};

const StatCard = ({ label, value, sub, icon: Icon, accent = 'indigo' }) => {
  const colors = {
    indigo: 'from-indigo-500 to-purple-600',
    emerald: 'from-emerald-500 to-teal-600',
    blue: 'from-blue-500 to-cyan-600',
    amber: 'from-amber-500 to-orange-600',
    rose: 'from-rose-500 to-pink-600',
    violet: 'from-violet-500 to-purple-600',
  };
  return (
    <div className="bg-white border border-black/[0.06] rounded-2xl p-6 flex items-start gap-4 shadow-sm hover:shadow-md transition-shadow">
      <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${colors[accent]} flex items-center justify-center flex-shrink-0`}>
        <Icon size={20} className="text-white" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-black/40 mb-1">{label}</p>
        <p className="text-3xl font-light text-black tracking-tight">{value}</p>
        {sub && <p className="text-[11px] text-black/30 mt-1">{sub}</p>}
      </div>
    </div>
  );
};

export default function Admin() {
  const sessionCtx = useSession();
  const router = useRouter();
  const session = sessionCtx?.data;
  const status = sessionCtx?.status;

  const [activeTab, setActiveTab] = useState('dashboard');
  const [stats, setStats] = useState(null);

  // Voucher states
  const [vouchers, setVouchers] = useState([]);
  const [voucherTotal, setVoucherTotal] = useState(0);
  const [voucherPage, setVoucherPage] = useState(1);
  const [voucherFilter, setVoucherFilter] = useState({ type: '', status: '', search: '' });
  const [selectedVouchers, setSelectedVouchers] = useState(new Set());
  const [voucherLoading, setVoucherLoading] = useState(false);

  // Transaction states
  const [transactions, setTransactions] = useState([]);
  const [txTotal, setTxTotal] = useState(0);
  const [txRevenue, setTxRevenue] = useState(0);
  const [txPage, setTxPage] = useState(1);
  const [txFilter, setTxFilter] = useState({ type: '', status: '', search: '' });

  // Preorder states
  const [preorders, setPreorders] = useState([]);
  const [preorderTotal, setPreorderTotal] = useState(0);

  // Settings
  const [settings, setSettings] = useState({});
  const [settingsEditing, setSettingsEditing] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState({});
  const [settingsLoading, setSettingsLoading] = useState(false);

  // Upload
  const [inputMode, setInputMode] = useState('manual');
  const [uploadType, setUploadType] = useState('WASSCE');
  const [file, setFile] = useState(null);
  const [manualSerial, setManualSerial] = useState('');
  const [manualPin, setManualPin] = useState('');
  const [uploadLoading, setUploadLoading] = useState(false);
  const fileInputRef = useRef(null);
  const [showPins, setShowPins] = useState(false);

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/admin/login');
  }, [status, router]);

  useEffect(() => {
    if (status === 'authenticated') {
      fetchStats();
      fetchSettings();
    }
  }, [status]);

  useEffect(() => {
    if (status === 'authenticated' && activeTab === 'vouchers') fetchVouchers();
  }, [activeTab, voucherPage, voucherFilter, status]);

  useEffect(() => {
    if (status === 'authenticated' && activeTab === 'transactions') fetchTransactions();
  }, [activeTab, txPage, txFilter, status]);

  useEffect(() => {
    if (status === 'authenticated' && activeTab === 'preorders') fetchPreorders();
  }, [activeTab, status]);

  const fetchStats = async () => {
    try {
      const res = await axios.get('/api/admin/stats');
      setStats(res.data);
    } catch (e) { toast.error('Failed to load stats'); }
  };

  const fetchVouchers = async () => {
    setVoucherLoading(true);
    try {
      const res = await axios.get('/api/admin/vouchers', {
        params: { page: voucherPage, limit: 50, ...voucherFilter }
      });
      setVouchers(res.data.vouchers);
      setVoucherTotal(res.data.total);
    } catch (e) { toast.error('Failed to load vouchers'); }
    setVoucherLoading(false);
  };

  const fetchTransactions = async () => {
    try {
      const res = await axios.get('/api/admin/transactions', {
        params: { page: txPage, limit: 50, ...txFilter }
      });
      setTransactions(res.data.transactions);
      setTxTotal(res.data.total);
      setTxRevenue(res.data.totalRevenue);
    } catch (e) { toast.error('Failed to load transactions'); }
  };

  const fetchPreorders = async () => {
    try {
      const res = await axios.get('/api/admin/preorders');
      setPreorders(res.data.preorders);
      setPreorderTotal(res.data.total);
    } catch (e) { toast.error('Failed to load preorders'); }
  };

  const fetchSettings = async () => {
    try {
      const res = await axios.get('/api/admin/settings');
      setSettings(res.data.settings);
      setSettingsDraft(res.data.settings);
    } catch (e) { console.error('Settings load failed'); }
  };

  const saveSettings = async () => {
    setSettingsLoading(true);
    try {
      await axios.put('/api/admin/settings', { settings: settingsDraft });
      setSettings(settingsDraft);
      setSettingsEditing(false);
      toast.success('Settings saved!');
    } catch (e) { toast.error('Failed to save settings'); }
    setSettingsLoading(false);
  };

  const handleDelete = async (serial) => {
    if (!confirm(`Delete voucher ${serial}?`)) return;
    try {
      await axios.delete(`/api/admin/delete-voucher?serial=${serial}`);
      toast.success('Voucher deleted');
      fetchVouchers();
      fetchStats();
    } catch (e) { toast.error('Delete failed'); }
  };

  const markVouchers = async (newStatus, serials) => {
    const list = serials || [...selectedVouchers];
    if (list.length === 0) return toast.error('No vouchers selected');
    try {
      await axios.post('/api/admin/mark-voucher', { serials: list, status: newStatus });
      toast.success(`Marked ${list.length} voucher(s) as ${newStatus}`);
      setSelectedVouchers(new Set());
      fetchVouchers();
      fetchStats();
    } catch (e) { toast.error('Update failed'); }
  };

  const fulfillPreorder = async (id) => {
    if (!confirm('Fulfill this pre-order and send SMS to customer?')) return;
    const t = toast.loading('Fulfilling pre-order...');
    try {
      const res = await axios.post('/api/admin/fulfill-preorder', { preorderId: id });
      toast.dismiss(t);
      toast.success(res.data.message);
      fetchPreorders();
      fetchVouchers();
      fetchStats();
    } catch (e) {
      toast.dismiss(t);
      toast.error(e?.response?.data?.error || 'Fulfillment failed');
    }
  };

  const processUpload = async (e) => {
    e.preventDefault();
    setUploadLoading(true);
    const formData = { type: uploadType };
    if (inputMode === 'manual') {
      if (!manualSerial || !manualPin) { setUploadLoading(false); return toast.error('Incomplete manual entry'); }
      formData.csvData = `${manualSerial},${manualPin}`;
    } else {
      if (!file) { setUploadLoading(false); return toast.error('No file selected'); }
      const text = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = (ev) => resolve(ev.target.result);
        r.onerror = reject;
        r.readAsText(file);
      });
      formData.csvData = text;
    }
    try {
      const res = await axios.post('/api/admin/upload', formData);
      toast.success(`Synced: ${res.data.summary.success} added, ${res.data.summary.failed} failed`);
      setFile(null); setManualSerial(''); setManualPin('');
      fetchStats();
      if (activeTab === 'vouchers') fetchVouchers();
    } catch (e) { toast.error('Upload failed'); }
    setUploadLoading(false);
  };

  // Print selected vouchers
  const printVouchers = (list) => {
    const toPrint = list || vouchers.filter(v => selectedVouchers.has(v.serial));
    if (toPrint.length === 0) return toast.error('No vouchers to print');
    const win = window.open('', '_blank');
    win.document.write(`
      <html><head><title>Vouchers Print</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 12px; }
        th { background: #4f46e5; color: white; }
        tr:nth-child(even) { background: #f9f9f9; }
        h2 { color: #4f46e5; }
        .footer { margin-top: 20px; font-size: 11px; color: #666; }
      </style></head><body>
      <h2>WAEC GH Checkers — Voucher List</h2>
      <p>Printed: ${new Date().toLocaleString()} | Total: ${toPrint.length}</p>
      <table>
        <tr><th>#</th><th>Type</th><th>Serial</th><th>PIN</th><th>Status</th><th>Sold To</th><th>Date</th></tr>
        ${toPrint.map((v, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${v.type}</td>
            <td>${v.serial}</td>
            <td>${v.pin}</td>
            <td>${v.status}</td>
            <td>${v.sold_to || '-'}</td>
            <td>${v.created_at ? new Date(v.created_at).toLocaleDateString() : '-'}</td>
          </tr>`).join('')}
      </table>
      <div class="footer">WAEC GH Checkers Admin System — Confidential</div>
      </body></html>
    `);
    win.document.close();
    win.print();
  };

  // PDF export
  const exportPDF = (list) => {
    const toExport = list || vouchers.filter(v => selectedVouchers.has(v.serial));
    if (toExport.length === 0) return toast.error('No vouchers selected');
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFontSize(16);
    doc.setTextColor(79, 70, 229);
    doc.text('WAEC GH Checkers — Voucher Export', 14, 20);
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Generated: ${new Date().toLocaleString()} | Total: ${toExport.length}`, 14, 28);
    doc.autoTable({
      head: [['#', 'Type', 'Serial', 'PIN', 'Status', 'Sold To', 'Created', 'Sold At']],
      body: toExport.map((v, i) => [
        i + 1, v.type, v.serial, v.pin, v.status,
        v.sold_to || '-',
        v.created_at ? new Date(v.created_at).toLocaleDateString() : '-',
        v.sold_at ? new Date(v.sold_at).toLocaleDateString() : '-',
      ]),
      startY: 35,
      theme: 'grid',
      headStyles: { fillColor: [79, 70, 229], textColor: 255 },
      styles: { fontSize: 8 },
    });
    doc.save(`vouchers_export_${Date.now()}.pdf`);
    toast.success('PDF downloaded!');
  };

  const exportTransactionsPDF = () => {
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFontSize(16);
    doc.setTextColor(79, 70, 229);
    doc.text('WAEC GH Checkers — Transactions Export', 14, 20);
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Generated: ${new Date().toLocaleString()} | Total Revenue: GHS ${txRevenue.toFixed(2)}`, 14, 28);
    doc.autoTable({
      head: [['Reference', 'Phone', 'Type', 'Qty', 'Amount', 'Status', 'Date']],
      body: transactions.map(t => [
        t.reference, t.phone, t.voucher_type, t.quantity,
        `GHS ${t.amount}`, t.status, new Date(t.created_at).toLocaleString(),
      ]),
      startY: 35,
      theme: 'grid',
      headStyles: { fillColor: [79, 70, 229], textColor: 255 },
      styles: { fontSize: 8 },
    });
    doc.save(`transactions_${Date.now()}.pdf`);
    toast.success('PDF downloaded!');
  };

  const toggleVoucherSelection = (serial) => {
    const next = new Set(selectedVouchers);
    if (next.has(serial)) next.delete(serial);
    else next.add(serial);
    setSelectedVouchers(next);
  };

  const selectAll = () => {
    if (selectedVouchers.size === vouchers.length) setSelectedVouchers(new Set());
    else setSelectedVouchers(new Set(vouchers.map(v => v.serial)));
  };

  if (status === 'loading') {
    return (
      <div className="min-h-screen bg-[#fafafa] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Fingerprint size={40} className="animate-pulse text-black/20" />
          <span className="text-[10px] font-black uppercase tracking-[0.3em] text-black/40">Authenticating...</span>
        </div>
      </div>
    );
  }
  if (status !== 'authenticated') return null;

  return (
    <div className="min-h-screen bg-[#f8fafc] text-[#1a1a1a] font-sans flex">
      <Toaster position="bottom-right" />

      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-black/[0.06] flex flex-col min-h-screen sticky top-0">
        {/* Logo */}
        <div className="h-20 flex items-center gap-3 px-6 border-b border-black/[0.06]">
          <div className="w-9 h-9 bg-gradient-to-br from-indigo-600 to-purple-600 rounded-xl flex items-center justify-center">
            <Fingerprint size={18} className="text-white" />
          </div>
          <div>
            <div className="font-black text-sm tracking-tight">Admin Console</div>
            <div className="flex items-center gap-1 text-[9px] font-bold text-emerald-500 uppercase tracking-widest">
              <ShieldCheck size={10} /> Secure
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-4 space-y-1">
          {TABS.map(tab => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-all text-sm font-semibold
                  ${active ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200' : 'text-black/50 hover:bg-black/[0.04] hover:text-black'}`}>
                <Icon size={16} />
                {tab.label}
                {tab.id === 'preorders' && preorderTotal > 0 && (
                  <span className="ml-auto bg-amber-500 text-white text-[9px] font-black px-2 py-0.5 rounded-full">{preorderTotal}</span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Sign out */}
        <div className="p-4 border-t border-black/[0.06]">
          <button onClick={() => signOut({ callbackUrl: '/admin/login' })}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold text-black/40 hover:text-red-500 hover:bg-red-50 transition-all">
            <LogOut size={16} /> Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 min-w-0 overflow-auto">
        {/* ===================== DASHBOARD ===================== */}
        {activeTab === 'dashboard' && (
          <div className="p-8">
            <div className="flex justify-between items-center mb-8">
              <div>
                <h1 className="text-2xl font-black tracking-tight">Dashboard</h1>
                <p className="text-sm text-black/40 mt-1">Overview of your voucher business</p>
              </div>
              <button onClick={() => { fetchStats(); toast.success('Refreshed'); }}
                className="flex items-center gap-2 text-sm font-bold text-black/40 hover:text-indigo-600 border border-black/10 px-4 py-2 rounded-xl transition-all">
                <RefreshCw size={14} /> Refresh
              </button>
            </div>

            {stats && (
              <>
                {/* Stats Grid */}
                <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 mb-8">
                  <StatCard label="Total Vouchers" value={stats.stats.total} icon={Package} accent="indigo" />
                  <StatCard label="Available" value={stats.stats.available} icon={CheckCircle} accent="emerald" sub="Ready to sell" />
                  <StatCard label="Sold" value={stats.stats.sold} icon={DollarSign} accent="blue" />
                  <StatCard label="Marked Used" value={stats.stats.used} icon={CheckCircle} accent="violet" />
                  <StatCard label="Revenue" value={`GHS ${(stats.stats.revenue || 0).toFixed(0)}`} icon={TrendingUp} accent="amber" />
                  <StatCard label="Pre-Orders" value={stats.stats.pendingPreorders} icon={ClipboardList} accent="rose" sub="Pending" />
                </div>

                {/* Per-Type Breakdown */}
                <div className="grid md:grid-cols-3 gap-4 mb-8">
                  {stats.byType.map(t => (
                    <div key={t.type} className="bg-white border border-black/[0.06] rounded-2xl p-6 shadow-sm">
                      <h3 className="font-black text-sm mb-4 uppercase tracking-wider text-indigo-600">{t.type}</h3>
                      <div className="space-y-3">
                        {[
                          { label: 'Available', val: t.available, color: 'bg-emerald-500' },
                          { label: 'Sold', val: t.sold, color: 'bg-blue-500' },
                          { label: 'Used', val: t.used, color: 'bg-gray-400' },
                        ].map(item => (
                          <div key={item.label}>
                            <div className="flex justify-between text-xs font-semibold mb-1">
                              <span className="text-black/50">{item.label}</span>
                              <span className="font-black">{item.val}</span>
                            </div>
                            <div className="h-1.5 bg-black/5 rounded-full overflow-hidden">
                              <div className={`h-full ${item.color} rounded-full transition-all`}
                                style={{ width: t.total > 0 ? `${(item.val / t.total) * 100}%` : '0%' }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Recent Transactions */}
                <div className="bg-white border border-black/[0.06] rounded-2xl shadow-sm overflow-hidden">
                  <div className="px-6 py-4 border-b border-black/[0.06] flex justify-between items-center">
                    <h3 className="font-black text-sm uppercase tracking-wider">Recent Transactions</h3>
                    <button onClick={() => setActiveTab('transactions')} className="text-xs font-bold text-indigo-600 hover:underline">View all →</button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-[#fafafa] border-b border-black/[0.05] text-[9px] font-black uppercase tracking-widest text-black/40">
                        <tr>
                          {['Reference', 'Phone', 'Type', 'Qty', 'Amount', 'Status', 'Date'].map(h => (
                            <th key={h} className="px-6 py-4 text-left">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-black/[0.04]">
                        {stats.recentTransactions.map((tx, i) => (
                          <tr key={i} className="hover:bg-[#fafafa] transition-colors">
                            <td className="px-6 py-3 font-mono text-[10px] text-black/50">{tx.reference?.slice(0, 20)}...</td>
                            <td className="px-6 py-3 text-xs font-semibold">{tx.phone}</td>
                            <td className="px-6 py-3"><span className="text-[9px] font-black text-indigo-600 bg-indigo-50 px-2 py-1 rounded">{tx.voucher_type}</span></td>
                            <td className="px-6 py-3 text-xs">{tx.quantity}</td>
                            <td className="px-6 py-3 text-xs font-bold">GHS {tx.amount}</td>
                            <td className="px-6 py-3"><StatusBadge status={tx.status} /></td>
                            <td className="px-6 py-3 text-[10px] text-black/40">{new Date(tx.created_at).toLocaleDateString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ===================== VOUCHERS ===================== */}
        {activeTab === 'vouchers' && (
          <div className="p-8">
            <div className="flex flex-col lg:flex-row gap-8">
              {/* Upload Panel */}
              <div className="lg:w-72 flex-shrink-0">
                <div className="bg-white border border-black/[0.06] rounded-2xl p-6 shadow-sm sticky top-8">
                  <h2 className="text-xs font-black uppercase tracking-[0.3em] mb-6 border-b border-black/5 pb-4">Add Vouchers</h2>
                  <form onSubmit={processUpload} className="space-y-5">
                    <div>
                      <label className="text-[10px] font-bold uppercase text-black/40 tracking-widest block mb-2">Category</label>
                      <select value={uploadType} onChange={e => setUploadType(e.target.value)}
                        className="w-full border border-black/10 rounded-xl py-2.5 px-3 text-sm font-bold outline-none focus:border-indigo-500 bg-white">
                        {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>

                    <div className="flex gap-1 p-1 bg-[#f0f0f0] rounded-xl">
                      {['manual', 'csv'].map(m => (
                        <button key={m} type="button" onClick={() => setInputMode(m)}
                          className={`flex-1 py-2 text-[10px] font-black uppercase tracking-wider rounded-lg transition-all ${inputMode === m ? 'bg-white shadow-sm text-indigo-600' : 'opacity-40'}`}>
                          {m === 'manual' ? 'Manual' : 'CSV Upload'}
                        </button>
                      ))}
                    </div>

                    {inputMode === 'manual' ? (
                      <div className="space-y-3">
                        <input type="text" placeholder="Serial Number" value={manualSerial}
                          onChange={e => setManualSerial(e.target.value)}
                          className="w-full bg-[#f9f9f9] border border-black/5 rounded-xl p-3 text-xs font-bold outline-none focus:border-indigo-300" />
                        <input type="text" placeholder="PIN Code" value={manualPin}
                          onChange={e => setManualPin(e.target.value)}
                          className="w-full bg-[#f9f9f9] border border-black/5 rounded-xl p-3 text-xs font-mono font-bold outline-none focus:border-indigo-300" />
                      </div>
                    ) : (
                      <div onClick={() => fileInputRef.current.click()}
                        className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all ${file ? 'border-indigo-400 bg-indigo-50' : 'border-black/10 hover:border-black/30'}`}>
                        <input type="file" hidden ref={fileInputRef} accept=".csv" onChange={e => {
                          const f = e.target.files[0];
                          if (f?.name.endsWith('.csv')) setFile(f);
                          else toast.error('Please upload a .csv file');
                        }} />
                        {file ? (
                          <div className="flex flex-col items-center gap-2">
                            <FileSpreadsheet className="text-indigo-500" size={28} />
                            <span className="text-[10px] font-black text-indigo-600">{file.name}</span>
                            <button type="button" onClick={e => { e.stopPropagation(); setFile(null); }}
                              className="text-red-400 text-[9px] font-bold hover:text-red-600">REMOVE</button>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center gap-2 opacity-40">
                            <UploadCloud size={28} />
                            <span className="text-[10px] font-black uppercase">Click to Select CSV</span>
                            <span className="text-[9px] text-black/30">Format: serial,pin (one per line)</span>
                          </div>
                        )}
                      </div>
                    )}

                    <button disabled={uploadLoading}
                      className="w-full bg-indigo-600 text-white py-4 rounded-xl flex items-center justify-center gap-2 hover:bg-indigo-700 transition-all font-black text-xs tracking-widest uppercase disabled:opacity-60">
                      {uploadLoading ? 'Processing...' : <><UploadCloud size={14} /> Sync Inventory</>}
                    </button>
                  </form>
                </div>
              </div>

              {/* Voucher Table */}
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-center mb-4 flex-wrap gap-3">
                  <h1 className="text-2xl font-black tracking-tight">Vouchers <span className="text-black/30 font-light">({voucherTotal})</span></h1>
                  <div className="flex gap-2 flex-wrap">
                    {selectedVouchers.size > 0 && (
                      <>
                        <span className="text-xs font-bold text-indigo-600 bg-indigo-50 px-3 py-2 rounded-xl">{selectedVouchers.size} selected</span>
                        <button onClick={() => markVouchers('used')} className="text-xs font-bold px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-xl transition-all flex items-center gap-1"><CheckCircle size={12} /> Mark Used</button>
                        <button onClick={() => markVouchers('available')} className="text-xs font-bold px-3 py-2 bg-emerald-100 hover:bg-emerald-200 text-emerald-700 rounded-xl transition-all flex items-center gap-1"><CheckCircle size={12} /> Mark Available</button>
                        <button onClick={() => printVouchers()} className="text-xs font-bold px-3 py-2 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded-xl transition-all flex items-center gap-1"><Printer size={12} /> Print</button>
                        <button onClick={() => exportPDF()} className="text-xs font-bold px-3 py-2 bg-violet-100 hover:bg-violet-200 text-violet-700 rounded-xl transition-all flex items-center gap-1"><Download size={12} /> PDF</button>
                      </>
                    )}
                    <button onClick={() => { exportPDF(vouchers); }} className="text-xs font-bold px-3 py-2 bg-black/5 hover:bg-black/10 rounded-xl transition-all flex items-center gap-1">
                      <Download size={12} /> Export All
                    </button>
                    <button onClick={() => setShowPins(!showPins)} className="text-xs font-bold px-3 py-2 bg-black/5 hover:bg-black/10 rounded-xl transition-all flex items-center gap-1">
                      {showPins ? <EyeOff size={12} /> : <Eye size={12} />} {showPins ? 'Hide PINs' : 'Show PINs'}
                    </button>
                  </div>
                </div>

                {/* Filters */}
                <div className="bg-white border border-black/[0.06] rounded-2xl p-4 mb-4 shadow-sm flex flex-wrap gap-3 items-center">
                  <div className="relative flex-1 min-w-[160px]">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-black/30" />
                    <input placeholder="Search serial, PIN, phone..." value={voucherFilter.search}
                      onChange={e => { setVoucherFilter(f => ({ ...f, search: e.target.value })); setVoucherPage(1); }}
                      className="w-full pl-9 pr-3 py-2 border border-black/10 rounded-xl text-sm outline-none focus:border-indigo-400" />
                  </div>
                  <select value={voucherFilter.type} onChange={e => { setVoucherFilter(f => ({ ...f, type: e.target.value })); setVoucherPage(1); }}
                    className="border border-black/10 rounded-xl px-3 py-2 text-sm font-semibold outline-none focus:border-indigo-400 bg-white">
                    <option value="">All Types</option>
                    {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <select value={voucherFilter.status} onChange={e => { setVoucherFilter(f => ({ ...f, status: e.target.value })); setVoucherPage(1); }}
                    className="border border-black/10 rounded-xl px-3 py-2 text-sm font-semibold outline-none focus:border-indigo-400 bg-white">
                    <option value="">All Statuses</option>
                    {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <button onClick={() => { setVoucherFilter({ type: '', status: '', search: '' }); setVoucherPage(1); }}
                    className="text-xs font-bold text-black/40 hover:text-red-500 px-3 py-2 border border-black/10 rounded-xl transition-all flex items-center gap-1">
                    <X size={12} /> Clear
                  </button>
                  <button onClick={fetchVouchers} className="text-xs font-bold text-indigo-600 px-3 py-2 border border-indigo-200 rounded-xl hover:bg-indigo-50 transition-all flex items-center gap-1">
                    <RefreshCw size={12} /> Refresh
                  </button>
                </div>

                <div className="bg-white border border-black/[0.06] rounded-2xl shadow-sm overflow-hidden">
                  {voucherLoading ? (
                    <div className="flex items-center justify-center h-40 text-black/30">
                      <RefreshCw size={24} className="animate-spin" />
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[#fafafa] border-b border-black/[0.05] text-[9px] font-black uppercase tracking-widest text-black/40">
                          <tr>
                            <th className="px-4 py-4">
                              <input type="checkbox" checked={selectedVouchers.size === vouchers.length && vouchers.length > 0}
                                onChange={selectAll} className="rounded" />
                            </th>
                            {['Type', 'Serial', 'PIN', 'Status', 'Sold To', 'Date', 'Actions'].map(h => (
                              <th key={h} className="px-4 py-4 text-left">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-black/[0.04]">
                          {vouchers.map((v) => (
                            <tr key={v.id} className={`hover:bg-[#fafafa] transition-colors ${selectedVouchers.has(v.serial) ? 'bg-indigo-50/50' : ''}`}>
                              <td className="px-4 py-3">
                                <input type="checkbox" checked={selectedVouchers.has(v.serial)}
                                  onChange={() => toggleVoucherSelection(v.serial)} className="rounded" />
                              </td>
                              <td className="px-4 py-3"><span className="text-[9px] font-black text-indigo-600 bg-indigo-50 px-2 py-1 rounded">{v.type}</span></td>
                              <td className="px-4 py-3 font-mono text-xs text-black/70">{v.serial}</td>
                              <td className="px-4 py-3 font-mono text-xs font-bold text-black/50">
                                {showPins ? v.pin : '••••••••'}
                              </td>
                              <td className="px-4 py-3"><StatusBadge status={v.status} /></td>
                              <td className="px-4 py-3 text-xs text-black/50">{v.sold_to || '-'}</td>
                              <td className="px-4 py-3 text-[10px] text-black/40">
                                {v.created_at ? new Date(v.created_at).toLocaleDateString() : '-'}
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-1">
                                  <button onClick={() => markVouchers('used', [v.serial])} title="Mark Used"
                                    className="p-1.5 rounded-lg hover:bg-gray-100 text-black/30 hover:text-gray-600 transition-colors">
                                    <CheckCircle size={14} />
                                  </button>
                                  <button onClick={() => markVouchers('available', [v.serial])} title="Mark Available"
                                    className="p-1.5 rounded-lg hover:bg-emerald-100 text-black/30 hover:text-emerald-600 transition-colors">
                                    <Check size={14} />
                                  </button>
                                  <button onClick={() => printVouchers([v])} title="Print"
                                    className="p-1.5 rounded-lg hover:bg-blue-100 text-black/30 hover:text-blue-600 transition-colors">
                                    <Printer size={14} />
                                  </button>
                                  <button onClick={() => exportPDF([v])} title="Save as PDF"
                                    className="p-1.5 rounded-lg hover:bg-violet-100 text-black/30 hover:text-violet-600 transition-colors">
                                    <Download size={14} />
                                  </button>
                                  <button onClick={() => handleDelete(v.serial)} title="Delete"
                                    className="p-1.5 rounded-lg hover:bg-red-100 text-black/30 hover:text-red-500 transition-colors">
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {vouchers.length === 0 && !voucherLoading && (
                        <div className="text-center py-12 text-black/30">
                          <Package size={32} className="mx-auto mb-2 opacity-30" />
                          <p className="text-sm font-semibold">No vouchers found</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Pagination */}
                  {voucherTotal > 50 && (
                    <div className="px-6 py-4 border-t border-black/[0.05] flex justify-between items-center">
                      <span className="text-xs text-black/40 font-semibold">
                        Showing {Math.min((voucherPage - 1) * 50 + 1, voucherTotal)}–{Math.min(voucherPage * 50, voucherTotal)} of {voucherTotal}
                      </span>
                      <div className="flex gap-2">
                        <button onClick={() => setVoucherPage(p => Math.max(1, p - 1))} disabled={voucherPage === 1}
                          className="p-2 rounded-xl border border-black/10 hover:bg-black/5 disabled:opacity-30 transition-all">
                          <ChevronLeft size={14} />
                        </button>
                        <button onClick={() => setVoucherPage(p => p + 1)} disabled={voucherPage * 50 >= voucherTotal}
                          className="p-2 rounded-xl border border-black/10 hover:bg-black/5 disabled:opacity-30 transition-all">
                          <ChevronRight size={14} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ===================== TRANSACTIONS ===================== */}
        {activeTab === 'transactions' && (
          <div className="p-8">
            <div className="flex justify-between items-center mb-6 flex-wrap gap-3">
              <div>
                <h1 className="text-2xl font-black tracking-tight">Transactions <span className="text-black/30 font-light">({txTotal})</span></h1>
                <p className="text-sm text-black/40 mt-1">Total Revenue: <strong className="text-emerald-600">GHS {txRevenue.toFixed(2)}</strong></p>
              </div>
              <button onClick={exportTransactionsPDF} className="flex items-center gap-2 text-sm font-bold text-violet-600 border border-violet-200 px-4 py-2 rounded-xl hover:bg-violet-50 transition-all">
                <Download size={14} /> Export PDF
              </button>
            </div>

            {/* Filters */}
            <div className="bg-white border border-black/[0.06] rounded-2xl p-4 mb-4 shadow-sm flex flex-wrap gap-3 items-center">
              <div className="relative flex-1 min-w-[160px]">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-black/30" />
                <input placeholder="Search reference or phone..." value={txFilter.search}
                  onChange={e => { setTxFilter(f => ({ ...f, search: e.target.value })); setTxPage(1); }}
                  className="w-full pl-9 pr-3 py-2 border border-black/10 rounded-xl text-sm outline-none focus:border-indigo-400" />
              </div>
              <select value={txFilter.type} onChange={e => { setTxFilter(f => ({ ...f, type: e.target.value })); setTxPage(1); }}
                className="border border-black/10 rounded-xl px-3 py-2 text-sm font-semibold outline-none focus:border-indigo-400 bg-white">
                <option value="">All Types</option>
                {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <select value={txFilter.status} onChange={e => { setTxFilter(f => ({ ...f, status: e.target.value })); setTxPage(1); }}
                className="border border-black/10 rounded-xl px-3 py-2 text-sm font-semibold outline-none focus:border-indigo-400 bg-white">
                <option value="">All Statuses</option>
                <option value="success">Success</option>
                <option value="preorder">Pre-Order</option>
              </select>
              <button onClick={() => { setTxFilter({ type: '', status: '', search: '' }); setTxPage(1); }}
                className="text-xs font-bold text-black/40 hover:text-red-500 px-3 py-2 border border-black/10 rounded-xl transition-all flex items-center gap-1">
                <X size={12} /> Clear
              </button>
            </div>

            <div className="bg-white border border-black/[0.06] rounded-2xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[#fafafa] border-b border-black/[0.05] text-[9px] font-black uppercase tracking-widest text-black/40">
                    <tr>
                      {['Reference', 'Phone', 'Type', 'Qty', 'Amount', 'Status', 'Date'].map(h => (
                        <th key={h} className="px-6 py-4 text-left">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-black/[0.04]">
                    {transactions.map((tx, i) => (
                      <tr key={i} className="hover:bg-[#fafafa] transition-colors">
                        <td className="px-6 py-3 font-mono text-[10px] text-black/50 max-w-[160px] truncate">{tx.reference}</td>
                        <td className="px-6 py-3 text-xs font-semibold">{tx.phone}</td>
                        <td className="px-6 py-3"><span className="text-[9px] font-black text-indigo-600 bg-indigo-50 px-2 py-1 rounded">{tx.voucher_type}</span></td>
                        <td className="px-6 py-3 text-xs">{tx.quantity}</td>
                        <td className="px-6 py-3 text-xs font-bold text-emerald-600">GHS {tx.amount}</td>
                        <td className="px-6 py-3"><StatusBadge status={tx.status} /></td>
                        <td className="px-6 py-3 text-[10px] text-black/40">{new Date(tx.created_at).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {transactions.length === 0 && (
                  <div className="text-center py-12 text-black/30">
                    <Receipt size={32} className="mx-auto mb-2 opacity-30" />
                    <p className="text-sm font-semibold">No transactions found</p>
                  </div>
                )}
              </div>

              {txTotal > 50 && (
                <div className="px-6 py-4 border-t border-black/[0.05] flex justify-between items-center">
                  <span className="text-xs text-black/40 font-semibold">Showing {Math.min((txPage - 1) * 50 + 1, txTotal)}–{Math.min(txPage * 50, txTotal)} of {txTotal}</span>
                  <div className="flex gap-2">
                    <button onClick={() => setTxPage(p => Math.max(1, p - 1))} disabled={txPage === 1}
                      className="p-2 rounded-xl border border-black/10 hover:bg-black/5 disabled:opacity-30 transition-all"><ChevronLeft size={14} /></button>
                    <button onClick={() => setTxPage(p => p + 1)} disabled={txPage * 50 >= txTotal}
                      className="p-2 rounded-xl border border-black/10 hover:bg-black/5 disabled:opacity-30 transition-all"><ChevronRight size={14} /></button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ===================== PRE-ORDERS ===================== */}
        {activeTab === 'preorders' && (
          <div className="p-8">
            <div className="flex justify-between items-center mb-6">
              <div>
                <h1 className="text-2xl font-black tracking-tight">Pre-Orders <span className="text-black/30 font-light">({preorderTotal})</span></h1>
                <p className="text-sm text-black/40 mt-1">Customers who paid when stock was unavailable</p>
              </div>
              <button onClick={fetchPreorders} className="flex items-center gap-2 text-sm font-bold text-black/40 hover:text-indigo-600 border border-black/10 px-4 py-2 rounded-xl transition-all">
                <RefreshCw size={14} /> Refresh
              </button>
            </div>

            {preorders.filter(p => p.status === 'pending').length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-6 flex items-center gap-3">
                <AlertCircle size={18} className="text-amber-600 flex-shrink-0" />
                <p className="text-sm font-semibold text-amber-800">
                  {preorders.filter(p => p.status === 'pending').length} pending pre-order(s) awaiting fulfillment. Upload vouchers, then click "Fulfill" to send them.
                </p>
              </div>
            )}

            <div className="bg-white border border-black/[0.06] rounded-2xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[#fafafa] border-b border-black/[0.05] text-[9px] font-black uppercase tracking-widest text-black/40">
                    <tr>
                      {['Customer', 'Name', 'Type', 'Qty', 'Amount', 'Reference', 'Status', 'Date', 'Action'].map(h => (
                        <th key={h} className="px-5 py-4 text-left">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-black/[0.04]">
                    {preorders.map((po) => (
                      <tr key={po.id} className="hover:bg-[#fafafa] transition-colors">
                        <td className="px-5 py-3 text-xs font-semibold flex items-center gap-1"><Phone size={12} className="text-black/30" />{po.phone}</td>
                        <td className="px-5 py-3 text-xs text-black/60">{po.name || '-'}</td>
                        <td className="px-5 py-3"><span className="text-[9px] font-black text-indigo-600 bg-indigo-50 px-2 py-1 rounded">{po.voucher_type}</span></td>
                        <td className="px-5 py-3 text-xs">{po.quantity}</td>
                        <td className="px-5 py-3 text-xs font-bold text-emerald-600">GHS {po.amount}</td>
                        <td className="px-5 py-3 font-mono text-[9px] text-black/40 max-w-[120px] truncate">{po.reference}</td>
                        <td className="px-5 py-3"><StatusBadge status={po.status} /></td>
                        <td className="px-5 py-3 text-[10px] text-black/40">{new Date(po.created_at).toLocaleDateString()}</td>
                        <td className="px-5 py-3">
                          {po.status === 'pending' ? (
                            <button onClick={() => fulfillPreorder(po.id)}
                              className="text-[10px] font-black bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-700 transition-all flex items-center gap-1">
                              <Send size={10} /> Fulfill
                            </button>
                          ) : (
                            <span className="text-[10px] text-black/30 font-semibold">{po.fulfilled_at ? new Date(po.fulfilled_at).toLocaleDateString() : '—'}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preorders.length === 0 && (
                  <div className="text-center py-12 text-black/30">
                    <ClipboardList size={32} className="mx-auto mb-2 opacity-30" />
                    <p className="text-sm font-semibold">No pre-orders yet</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ===================== SETTINGS ===================== */}
        {activeTab === 'settings' && (
          <div className="p-8 max-w-3xl">
            <div className="flex justify-between items-center mb-8">
              <div>
                <h1 className="text-2xl font-black tracking-tight">Settings</h1>
                <p className="text-sm text-black/40 mt-1">Configure your system preferences</p>
              </div>
              {settingsEditing ? (
                <div className="flex gap-2">
                  <button onClick={() => { setSettingsDraft(settings); setSettingsEditing(false); }}
                    className="text-sm font-bold text-black/40 border border-black/10 px-4 py-2 rounded-xl hover:bg-black/5 transition-all flex items-center gap-1">
                    <X size={14} /> Cancel
                  </button>
                  <button onClick={saveSettings} disabled={settingsLoading}
                    className="text-sm font-bold bg-indigo-600 text-white px-4 py-2 rounded-xl hover:bg-indigo-700 transition-all flex items-center gap-1 disabled:opacity-60">
                    <Save size={14} /> {settingsLoading ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              ) : (
                <button onClick={() => setSettingsEditing(true)}
                  className="text-sm font-bold text-indigo-600 border border-indigo-200 px-4 py-2 rounded-xl hover:bg-indigo-50 transition-all flex items-center gap-1">
                  <Edit3 size={14} /> Edit Settings
                </button>
              )}
            </div>

            <div className="space-y-6">
              {/* WhatsApp Alert Settings */}
              <div className="bg-white border border-black/[0.06] rounded-2xl p-6 shadow-sm">
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center">
                    <Phone size={18} className="text-emerald-600" />
                  </div>
                  <div>
                    <h3 className="font-black text-sm">WhatsApp Alerts</h3>
                    <p className="text-xs text-black/40">Receive stock and pre-order alerts via WhatsApp</p>
                  </div>
                </div>
                <div className="space-y-4">
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-[0.2em] text-black/40 block mb-2">Admin WhatsApp Number</label>
                    {settingsEditing ? (
                      <input value={settingsDraft.admin_whatsapp || ''}
                        onChange={e => setSettingsDraft(d => ({ ...d, admin_whatsapp: e.target.value }))}
                        placeholder="e.g. 0244123456"
                        className="w-full border border-black/10 rounded-xl px-4 py-3 text-sm outline-none focus:border-indigo-400" />
                    ) : (
                      <p className="text-sm font-semibold py-3 px-4 bg-[#fafafa] rounded-xl border border-black/[0.06]">
                        {settings.admin_whatsapp || <span className="text-black/30">Not set</span>}
                      </p>
                    )}
                    <p className="text-[10px] text-black/30 mt-1">You'll get alerts when stock drops below 5 or runs out.</p>
                  </div>
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-[0.2em] text-black/40 block mb-2">Low Stock Threshold</label>
                    {settingsEditing ? (
                      <input type="number" min="1" max="20" value={settingsDraft.low_stock_threshold || '5'}
                        onChange={e => setSettingsDraft(d => ({ ...d, low_stock_threshold: e.target.value }))}
                        className="w-32 border border-black/10 rounded-xl px-4 py-3 text-sm outline-none focus:border-indigo-400" />
                    ) : (
                      <p className="text-sm font-semibold py-3 px-4 bg-[#fafafa] rounded-xl border border-black/[0.06] w-32">
                        {settings.low_stock_threshold || '5'}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Pricing */}
              <div className="bg-white border border-black/[0.06] rounded-2xl p-6 shadow-sm">
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center">
                    <DollarSign size={18} className="text-amber-600" />
                  </div>
                  <div>
                    <h3 className="font-black text-sm">Voucher Prices</h3>
                    <p className="text-xs text-black/40">Set the selling price for each voucher type (GHS)</p>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  {TYPES.map(type => (
                    <div key={type}>
                      <label className="text-[10px] font-black uppercase tracking-[0.2em] text-black/40 block mb-2">{type}</label>
                      {settingsEditing ? (
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-black/30">GHS</span>
                          <input type="number" min="1" value={settingsDraft[`price_${type}`] || '30'}
                            onChange={e => setSettingsDraft(d => ({ ...d, [`price_${type}`]: e.target.value }))}
                            className="w-full border border-black/10 rounded-xl pl-12 pr-4 py-3 text-sm font-bold outline-none focus:border-indigo-400" />
                        </div>
                      ) : (
                        <p className="text-2xl font-black py-3 px-4 bg-[#fafafa] rounded-xl border border-black/[0.06]">
                          GHS {settings[`price_${type}`] || '30'}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Moolre Credentials Info */}
              <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-6">
                <div className="flex items-start gap-3">
                  <AlertCircle size={18} className="text-indigo-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <h3 className="font-black text-sm text-indigo-800 mb-2">Moolre & API Configuration</h3>
                    <p className="text-xs text-indigo-700 leading-relaxed">
                      Moolre keys, Arkesel SMS key, database URL, and admin credentials are configured via environment variables in your <code className="bg-indigo-100 px-1 rounded">.env.local</code> file. Update these directly on your server or hosting platform.
                    </p>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] font-mono text-indigo-600">
                      {['MOOLRE_SECRET_KEY', 'NEXT_PUBLIC_MOOLRE_PUBLIC_KEY', 'NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER', 'ARKESEL_API_KEY', 'ULTRAMSG_TOKEN', 'ULTRAMSG_INSTANCE_ID', 'DATABASE_URL', 'ADMIN_USERNAME', 'ADMIN_PASSWORD'].map(k => (
                        <div key={k} className="bg-indigo-100 rounded px-2 py-1 truncate">{k}</div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* USSD Info */}
              <div className="bg-white border border-black/[0.06] rounded-2xl p-6 shadow-sm">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 bg-violet-100 rounded-xl flex items-center justify-center">
                    <Phone size={18} className="text-violet-600" />
                  </div>
                  <div>
                    <h3 className="font-black text-sm">USSD Integration</h3>
                    <p className="text-xs text-black/40">Your backend USSD endpoint is ready at <code className="bg-gray-100 px-1 rounded">/api/ussd</code></p>
                  </div>
                </div>
                <p className="text-xs text-black/50 leading-relaxed">
                  The USSD service uses the same database as the web app. Configure your USSD provider (GiantSMS, etc.) to POST to <strong>/api/ussd</strong> with <code>msisdn</code>, <code>msgType</code>, and <code>text</code> parameters.
                  The USSD flow supports buying WASSCE, BECE, and CSSPS vouchers via Mobile Money push prompts.
                </p>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export const getServerSideProps = async () => ({ props: {} });
