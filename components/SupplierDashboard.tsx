
import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../hooks/useAuth';
import { getChatsStream, triggerMatching, broadcastMessage } from '../services/chatService';
import { getNotificationsStream } from '../services/notificationService';
import { Chat, Notification } from '../types';
import { LogoutIcon, BellIcon, MegaphoneIcon, ChartBarIcon, UsersIcon, TrendingUpIcon, XMarkIcon } from './icons';
import { ChatParams } from '../App';
import Toast from './Toast';

interface SupplierDashboardProps {
    onNavigateToChat: (params: ChatParams) => void;
    onOpenNotifications: () => void;
}

const SupplierDashboard: React.FC<SupplierDashboardProps> = ({ onNavigateToChat, onOpenNotifications }) => {
    const { user, userProfile, logOut } = useAuth();
    const [chats, setChats] = useState<Chat[]>([]);
    const [loading, setLoading] = useState(true);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [totalUnreadChatCount, setTotalUnreadChatCount] = useState(0);
    const [totalUnreadNotificationCount, setTotalUnreadNotificationCount] = useState(0);
    
    // Filter State
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
    
    // Broadcast State
    const [isBroadcastOpen, setIsBroadcastOpen] = useState(false);
    const [broadcastText, setBroadcastText] = useState('');
    const [isBroadcasting, setIsBroadcasting] = useState(false);
    const [toastMessage, setToastMessage] = useState('');

    useEffect(() => {
        if (!userProfile?.uid) return;
        setLoading(true);
        const unsubChats = getChatsStream(userProfile.uid, (fetchedChats) => {
            setChats(fetchedChats);
            const unreadSum = fetchedChats.reduce((sum, chat) => sum + (chat.unreadCount[userProfile.uid] || 0), 0);
            setTotalUnreadChatCount(unreadSum);
            setLoading(false);
        });
        const unsubNotifications = getNotificationsStream(userProfile.uid, (notifications: Notification[]) => {
            const unreadSum = notifications.filter(n => !n.read).length;
            setTotalUnreadNotificationCount(unreadSum);
        });
        return () => {
            unsubChats();
            unsubNotifications();
        };
    }, [userProfile?.uid]);

    const handleRefreshMatches = async () => {
        if (!userProfile) return;
        setIsRefreshing(true);
        await triggerMatching(userProfile);
        setTimeout(() => setIsRefreshing(false), 1000);
    };

    const groupedChats = useMemo<{ [key: string]: Chat[] }>(() => {
        const groups: { [key: string]: Chat[] } = {};
        chats.forEach(chat => {
            const category = chat.categoriesMatched[0] || 'general';
            if (!groups[category]) {
                groups[category] = [];
            }
            groups[category].push(chat);
        });
        return Object.keys(groups).sort().reduce((acc, key) => {
            acc[key] = groups[key];
            return acc;
        }, {} as { [key: string]: Chat[] });
    }, [chats]);

    // Analytics Data
    const totalConnections = chats.length;
    // Sort categories by number of chats to find top demand
    const topCategoryEntry = (Object.entries(groupedChats) as [string, Chat[]][]).sort((a, b) => b[1].length - a[1].length)[0];
    const topCategory = topCategoryEntry ? topCategoryEntry[0] : 'N/A';
    const topCategoryCount = topCategoryEntry ? topCategoryEntry[1].length : 0;
    
    const activeChatsCount = chats.filter(c => c.lastMessageText && c.lastMessageText !== 'You are now connected!').length;

    const handleChatClick = (chat: Chat) => {
        onNavigateToChat({ 
            chatId: chat.id, 
            chatTitle: `Chat with ${chat.sellerName}`
        });
    };

    const handleBroadcast = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!broadcastText.trim() || !userProfile) return;
        
        setIsBroadcasting(true);
        try {
            // Filter chat IDs based on selected category if active
            const targetChats = selectedCategory 
                ? groupedChats[selectedCategory] || [] 
                : chats;
                
            const chatIds = targetChats.map(c => c.id);
            
            if (chatIds.length === 0) {
                setToastMessage('No sellers found in this category.');
                setIsBroadcasting(false);
                return;
            }

            const result = await broadcastMessage(chatIds, userProfile, broadcastText.trim());
            setToastMessage(`Offer sent to ${result.count} sellers!`);
            setIsBroadcastOpen(false);
            setBroadcastText('');
        } catch (error) {
            console.error(error);
            setToastMessage('Failed to send broadcast.');
        } finally {
            setIsBroadcasting(false);
        }
    };

    return (
        <main className="container mx-auto p-4 md:p-8 pb-24">
            <Toast message={toastMessage} onClose={() => setToastMessage('')} />
            
            <header className="flex flex-col md:flex-row justify-between items-center mb-8 gap-4">
                <div>
                    <h1 className="text-3xl md:text-4xl font-bold text-gray-900 dark:text-white">Supplier Dashboard</h1>
                    <p className="text-gray-500 dark:text-gray-400">Welcome, {userProfile?.name}</p>
                </div>
                 <div className="flex items-center gap-3">
                    <button onClick={onOpenNotifications} title="Notifications" className="relative p-3 text-gray-500 dark:text-white bg-gray-200 dark:bg-gray-700 rounded-full hover:bg-gray-300 dark:hover:bg-gray-600">
                        <BellIcon className="w-5 h-5" />
                        {totalUnreadNotificationCount > 0 && <span className="absolute top-0 right-0 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs text-white ring-2 ring-white dark:ring-gray-700">{totalUnreadNotificationCount}</span>}
                    </button>
                    <button onClick={logOut} title="Logout" className="p-3 text-gray-500 dark:text-white bg-gray-200 dark:bg-gray-700 rounded-full hover:bg-gray-300 dark:hover:bg-gray-600">
                        <LogoutIcon className="w-5 h-5" />
                    </button>
                </div>
            </header>

            {/* Analytics Section */}
            <section className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                <div className="bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl p-6 text-white shadow-lg relative overflow-hidden">
                    <div className="relative z-10">
                        <p className="text-indigo-100 font-medium mb-1">Total Reach</p>
                        <h3 className="text-4xl font-bold">{totalConnections}</h3>
                        <p className="text-sm text-indigo-200 mt-2">Connected Sellers</p>
                    </div>
                    <UsersIcon className="absolute -bottom-4 -right-4 w-24 h-24 text-white opacity-10" />
                </div>
                
                <div className="bg-white dark:bg-gray-800 rounded-xl p-6 shadow-md border border-gray-200 dark:border-gray-700 relative">
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-gray-500 dark:text-gray-400 font-medium">Active Conversations</h3>
                        <div className="p-2 bg-green-100 dark:bg-green-900/30 rounded-full">
                            <TrendingUpIcon className="w-5 h-5 text-green-600 dark:text-green-400" />
                        </div>
                    </div>
                    <p className="text-3xl font-bold text-gray-900 dark:text-white">{activeChatsCount}</p>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Sellers actively chatting</p>
                </div>

                {/* Interactive Top Demand Card */}
                <div 
                    onClick={() => topCategory !== 'N/A' && setSelectedCategory(selectedCategory === topCategory ? null : topCategory)}
                    className={`bg-white dark:bg-gray-800 rounded-xl p-6 shadow-md border border-gray-200 dark:border-gray-700 relative transition-all cursor-pointer
                        ${selectedCategory === topCategory ? 'ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'hover:shadow-lg hover:border-blue-300'}
                    `}
                >
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-gray-500 dark:text-gray-400 font-medium">Top Demand</h3>
                        <div className={`p-2 rounded-full ${selectedCategory === topCategory ? 'bg-blue-500 text-white' : 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'}`}>
                            <ChartBarIcon className="w-5 h-5" />
                        </div>
                    </div>
                    <p className="text-3xl font-bold text-gray-900 dark:text-white capitalize truncate">{topCategory}</p>
                    <div className="flex justify-between items-center mt-1">
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                            {topCategoryCount} {topCategoryCount === 1 ? 'Seller' : 'Sellers'}
                        </p>
                        <span className="text-xs text-blue-600 dark:text-blue-400 font-medium">
                            {selectedCategory === topCategory ? 'Filter Active' : 'Click to Filter'}
                        </span>
                    </div>
                </div>
            </section>

            {/* Main Content Area */}
            <div className="bg-white dark:bg-gray-800 dark:bg-opacity-50 backdrop-blur-md rounded-xl shadow-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex flex-col md:flex-row justify-between items-center gap-4">
                    <div className="flex items-center gap-3">
                        <h2 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                            <span>Matched Seller Chats</span>
                            {totalUnreadChatCount > 0 && (
                                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-xs font-bold text-white">
                                    {totalUnreadChatCount}
                                </span>
                            )}
                        </h2>
                        {selectedCategory && (
                            <span className="px-3 py-1 bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 text-xs font-bold rounded-full uppercase flex items-center gap-2">
                                {selectedCategory}
                                <button onClick={(e) => { e.stopPropagation(); setSelectedCategory(null); }} className="hover:text-red-500">
                                    &times;
                                </button>
                            </span>
                        )}
                    </div>
                    <div className="flex gap-3 w-full md:w-auto">
                         <button
                            onClick={() => setIsBroadcastOpen(true)}
                            className="flex-1 md:flex-none flex items-center justify-center gap-2 px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-full shadow-md transition-all text-sm font-semibold"
                        >
                            <MegaphoneIcon className="w-4 h-4" />
                            {selectedCategory ? `Flash Deal (${selectedCategory})` : 'Flash Deal (All)'}
                        </button>
                        <button
                            onClick={handleRefreshMatches}
                            disabled={isRefreshing}
                            className="flex-1 md:flex-none px-4 py-2 text-sm text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20 dark:text-indigo-300 rounded-full hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-all disabled:opacity-50"
                        >
                            {isRefreshing ? 'Syncing...' : 'Refresh List'}
                        </button>
                    </div>
                </div>

                {loading ? (
                    <p className="p-4 text-gray-500 dark:text-gray-400 text-center py-12">Loading connections...</p>
                ) : chats.length === 0 ? (
                    <div className="text-center p-10 md:p-16">
                        <div className="max-w-md mx-auto">
                            <h2 className="text-xl font-semibold text-gray-800 dark:text-white mb-2">No Connections Yet</h2>
                            <p className="text-gray-500 dark:text-gray-400 mb-6">
                                We're looking for sellers who match your categories. Check back soon.
                            </p>
                            <button onClick={handleRefreshMatches} className="px-6 py-3 text-white bg-indigo-600 rounded-full hover:bg-indigo-700 shadow-lg transition duration-150 ease-in-out font-semibold">
                                Refresh Matches
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="max-h-[60vh] overflow-y-auto">
                        {Object.entries(groupedChats)
                            .filter(([category]) => selectedCategory ? category === selectedCategory : true)
                            .map(([category, categoryChats]: [string, Chat[]]) => (
                            <div key={category}>
                                <h3 
                                    onClick={() => setSelectedCategory(selectedCategory === category ? null : category)}
                                    className={`text-xs font-bold uppercase px-4 py-2 sticky top-0 capitalize tracking-wider cursor-pointer flex justify-between items-center
                                        ${selectedCategory === category 
                                            ? 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-100' 
                                            : 'bg-gray-50 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600'}
                                    `}
                                >
                                    {category}
                                    <span className="text-[10px] opacity-60">
                                        {selectedCategory === category ? 'Click to Show All' : 'Click to Filter'}
                                    </span>
                                </h3>
                                <ul>
                                    {categoryChats.map(chat => {
                                        const hasUnread = user ? chat.unreadCount[user.uid] > 0 : false;
                                        return (
                                            <li key={chat.id} 
                                                onClick={() => handleChatClick(chat)}
                                                className={`p-4 border-b border-gray-200 dark:border-gray-700 cursor-pointer transition-all flex justify-between items-center group
                                                    ${hasUnread ? 'bg-indigo-50 dark:bg-indigo-900/20' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'}
                                                `}
                                            >
                                                <div className="flex items-center gap-4">
                                                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold text-white shadow-sm
                                                        ${hasUnread ? 'bg-indigo-600' : 'bg-gray-400 dark:bg-gray-600'}
                                                    `}>
                                                        {chat.sellerName?.charAt(0)?.toUpperCase() || '?'}
                                                    </div>
                                                    <div>
                                                        <p className={`font-semibold text-gray-900 dark:text-white ${hasUnread ? 'font-bold' : ''}`}>
                                                            {chat.sellerName || 'Unknown Seller'}
                                                        </p>
                                                        <p className={`text-sm truncate max-w-[200px] md:max-w-sm ${hasUnread ? 'text-indigo-600 dark:text-indigo-400 font-medium' : 'text-gray-500 dark:text-gray-400'}`}>
                                                            {chat.lastMessageText}
                                                        </p>
                                                    </div>
                                                </div>
                                                <div className="flex flex-col items-end gap-1">
                                                    {hasUnread && (
                                                        <span className="w-3 h-3 bg-indigo-500 rounded-full"></span>
                                                    )}
                                                    <span className="text-xs text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity">Open Chat &rarr;</span>
                                                </div>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        ))}
                        {/* Empty state if filter yields no results */}
                        {Object.entries(groupedChats).filter(([category]) => selectedCategory ? category === selectedCategory : true).length === 0 && (
                            <div className="p-8 text-center text-gray-500 dark:text-gray-400">
                                No chats found in the selected category.
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Broadcast Modal */}
            {isBroadcastOpen && (
                <div className="fixed inset-0 bg-black bg-opacity-60 z-50 flex items-center justify-center backdrop-blur-sm p-4">
                    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden relative">
                        <button onClick={() => setIsBroadcastOpen(false)} className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                            <XMarkIcon className="w-6 h-6" />
                        </button>
                        
                        <div className="bg-orange-500 p-6 text-white">
                            <div className="flex items-center gap-3 mb-2">
                                <MegaphoneIcon className="w-8 h-8" />
                                <h2 className="text-2xl font-bold">
                                    {selectedCategory ? `Broadcast to ${selectedCategory}` : 'Broadcast Flash Deal'}
                                </h2>
                            </div>
                            <p className="text-orange-100 text-sm">
                                {selectedCategory 
                                    ? `Send a targeted offer to all ${groupedChats[selectedCategory]?.length || 0} sellers in ${selectedCategory}.` 
                                    : `Send a message to all ${totalConnections} connected sellers instantly.`
                                }
                            </p>
                        </div>

                        <form onSubmit={handleBroadcast} className="p-6">
                            <div className="mb-4">
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Your Offer Message</label>
                                <textarea
                                    rows={4}
                                    className="w-full p-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none resize-none"
                                    placeholder={selectedCategory 
                                        ? `e.g., Special discount on ${selectedCategory} items! 10% off until stocks last.` 
                                        : "e.g., Fresh stock of Alphonsos arrived! ₹1200/doz. Order before 5 PM for same-day delivery."
                                    }
                                    value={broadcastText}
                                    onChange={(e) => setBroadcastText(e.target.value)}
                                    required
                                />
                            </div>
                            <div className="flex justify-end gap-3">
                                <button 
                                    type="button"
                                    onClick={() => setIsBroadcastOpen(false)}
                                    className="px-4 py-2 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 font-medium"
                                >
                                    Cancel
                                </button>
                                <button 
                                    type="submit"
                                    disabled={isBroadcasting || !broadcastText.trim()}
                                    className="px-6 py-2 rounded-lg bg-orange-500 hover:bg-orange-600 text-white font-bold shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                                >
                                    {isBroadcasting ? 'Sending...' : 'Send Offer'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </main>
    );
};

export default SupplierDashboard;
