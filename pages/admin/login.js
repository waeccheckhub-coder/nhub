import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { Fingerprint, ArrowRight, ShieldAlert } from 'lucide-react';
import toast, { Toaster } from 'react-hot-toast';

export default function AdminLogin() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    const result = await signIn('credentials', {
      redirect: false,
      username,
      password,
    });

    if (result.error) {
      toast.error("Access Denied: Invalid Credentials");
      setLoading(false);
    } else {
      toast.success("Identity Verified");
      router.push('/admin');
    }
  };

  return (
    <div className="min-h-screen bg-[#fafafa] flex items-center justify-center p-6 font-sans">
      <Head><title>TERMINAL ACCESS | NEONCHECK</title></Head>
      <Toaster position="top-center" />
      
      <div className="w-full max-w-md">
        <div className="bg-white border border-black/10 rounded-sm p-10 shadow-sm">
          {/* Brand Header */}
          <div className="flex flex-col items-center mb-12">
            <div className="w-12 h-12 bg-black rounded-full flex items-center justify-center mb-4">
              <Fingerprint size={24} className="text-white" />
            </div>
            <h1 className="text-xs font-black uppercase tracking-[0.4em] text-black">System Authentication</h1>
            <p className="text-[10px] text-black/40 uppercase mt-2 font-bold tracking-widest">Authorized Personnel Only</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <label className="text-[9px] font-black uppercase text-black/40 tracking-[0.2em]">Operator ID</label>
              <input 
                type="text" 
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-[#f9f9f9] border border-black/5 p-4 text-xs font-bold outline-none focus:border-black/20 transition-all"
                placeholder="USERNAME"
                required
              />
            </div>

            <div className="space-y-2">
              <label className="text-[9px] font-black uppercase text-black/40 tracking-[0.2em]">Access Key</label>
              <input 
                type="password" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-[#f9f9f9] border border-black/5 p-4 text-xs font-bold outline-none focus:border-black/20 transition-all"
                placeholder="••••••••"
                required
              />
            </div>

            <button 
              disabled={loading}
              className="w-full bg-black text-white py-5 flex items-center justify-center gap-3 group hover:bg-[#333] transition-all disabled:opacity-50"
            >
              <span className="text-xs font-black uppercase tracking-[0.2em]">
                {loading ? 'Verifying...' : 'Initialize Session'}
              </span>
              {!loading && <ArrowRight size={16} className="group-hover:translate-x-1 transition-transform" />}
            </button>
          </form>

          {/* Security Footer */}
          <div className="mt-10 pt-6 border-t border-black/5 flex items-center justify-center gap-2">
            <ShieldAlert size={12} className="text-red-500" />
            <span className="text-[9px] font-bold uppercase text-black/30 tracking-widest">Enforcing Secure Protocol 442</span>
          </div>
        </div>
        
        <p className="text-center mt-8 text-[9px] font-bold uppercase tracking-[0.3em] text-black/20">
          NeonCheck Infrastructure &copy; 2025
        </p>
      </div>
    </div>
  );
}
