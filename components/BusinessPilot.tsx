
import React, { useState, useEffect } from 'react';
import { getAi } from '../services/geminiService';
import { InventoryItem } from '../types';
import { SparklesIcon, LightBulbIcon, ShareIcon } from './icons';
import { Type } from '@google/genai';

interface BusinessPilotProps {
    inventory: InventoryItem[];
    onIncrementUsage: (feature: 'aiScans' | 'promosGenerated') => Promise<void>;
}

interface Insight {
    type: 'opportunity' | 'warning';
    title: string;
    description: string;
    action: 'promote' | 'restock';
    targetItemName: string;
}

const BusinessPilot: React.FC<BusinessPilotProps> = ({ inventory, onIncrementUsage }) => {
    const [insights, setInsights] = useState<Insight[]>([]);
    const [loading, setLoading] = useState(false);
    const [promoContent, setPromoContent] = useState<string | null>(null);
    const [isGeneratingPromo, setIsGeneratingPromo] = useState(false);

    useEffect(() => {
        if (inventory.length > 0 && insights.length === 0) {
            generateInsights();
        }
    }, [inventory]);

    const generateInsights = async () => {
        setLoading(true);
        const ai = getAi();
        const inventorySummary = inventory.map(i => ({
            name: i.name,
            qty: i.quantity,
            expiry: i.expiryDate || 'N/A',
            price: i.price
        })).slice(0, 20); // Limit to top 20 for token efficiency

        const prompt = `Analyze this inventory list for a small shopkeeper. Identify 2 critical business insights:
        1. One "Warning" (e.g., item expiring soon, high value stock stuck).
        2. One "Opportunity" (e.g., popular item running low, or seasonal opportunity).
        
        For each, suggest a concrete action: 'promote' (for expiring/stuck) or 'restock' (for low stock).
        Inventory: ${JSON.stringify(inventorySummary)}.
        Return JSON format.`;

        try {
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
                config: {
                    responseMimeType: 'application/json',
                    responseSchema: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                type: { type: Type.STRING, enum: ['opportunity', 'warning'] },
                                title: { type: Type.STRING },
                                description: { type: Type.STRING },
                                action: { type: Type.STRING, enum: ['promote', 'restock'] },
                                targetItemName: { type: Type.STRING }
                            },
                            required: ['type', 'title', 'description', 'action', 'targetItemName']
                        }
                    }
                }
            });
            
            if (response.text) {
                const data = JSON.parse(response.text);
                setInsights(data);
            }
        } catch (error) {
            console.error("Failed to generate insights", error);
        } finally {
            setLoading(false);
        }
    };

    const generatePromo = async (itemName: string) => {
        setIsGeneratingPromo(true);
        const ai = getAi();
        const prompt = `Write a catchy, short WhatsApp Status promo message (in a mix of English and Hindi/Hinglish) for a shopkeeper selling "${itemName}". 
        It is expiring soon or on sale. Make it urgent and exciting. Use emojis. Max 30 words.`;

        try {
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt
            });
            setPromoContent(response.text || null);
            await onIncrementUsage('promosGenerated');
        } catch (error) {
            console.error("Promo gen failed", error);
        } finally {
            setIsGeneratingPromo(false);
        }
    };

    const handleShare = () => {
        if (navigator.share && promoContent) {
            navigator.share({
                title: 'Stock Pilot Promo',
                text: promoContent,
            }).catch(console.error);
        } else {
            // Fallback: Copy to clipboard
            if (promoContent) {
                navigator.clipboard.writeText(promoContent);
                alert("Message copied to clipboard!");
            }
        }
    };

    if (loading) return null;
    if (insights.length === 0) return null;

    return (
        <div className="mb-8 grid gap-4 md:grid-cols-2">
            {insights.map((insight, idx) => (
                <div key={idx} className={`relative overflow-hidden rounded-xl p-5 shadow-md border ${insight.type === 'warning' ? 'bg-red-50 border-red-100 dark:bg-red-900/20 dark:border-red-800' : 'bg-blue-50 border-blue-100 dark:bg-blue-900/20 dark:border-blue-800'}`}>
                    <div className="absolute top-0 right-0 p-4 opacity-10">
                        {insight.type === 'warning' ? <LightBulbIcon className="w-16 h-16" /> : <SparklesIcon className="w-16 h-16" />}
                    </div>
                    
                    <div className="relative z-10">
                        <div className="flex items-center gap-2 mb-2">
                            <span className={`text-xs font-bold uppercase tracking-wider py-1 px-2 rounded-full ${insight.type === 'warning' ? 'bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200' : 'bg-blue-200 text-blue-800 dark:bg-blue-800 dark:text-blue-200'}`}>
                                {insight.type === 'warning' ? 'Action Needed' : 'Growth Tip'}
                            </span>
                        </div>
                        <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-1">{insight.title}</h3>
                        <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">{insight.description}</p>

                        {insight.action === 'promote' && (
                            <button 
                                onClick={() => generatePromo(insight.targetItemName)}
                                className="flex items-center gap-2 text-sm font-semibold text-white bg-gradient-to-r from-purple-500 to-indigo-600 px-4 py-2 rounded-lg shadow hover:shadow-lg transition-all"
                            >
                                <SparklesIcon className="w-4 h-4" />
                                Generate WhatsApp Promo
                            </button>
                        )}
                    </div>
                </div>
            ))}

            {/* Promo Modal/Overlay */}
            {promoContent && (
                <div className="fixed inset-0 bg-black bg-opacity-60 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
                    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl max-w-sm w-full p-6 animate-fade-in-down">
                        <div className="text-center mb-4">
                            <div className="w-12 h-12 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-3">
                                <SparklesIcon className="w-6 h-6 text-green-600 dark:text-green-400" />
                            </div>
                            <h3 className="text-xl font-bold text-gray-900 dark:text-white">Ready to Post!</h3>
                            <p className="text-sm text-gray-500 dark:text-gray-400">Share this on your WhatsApp Status.</p>
                        </div>
                        
                        <div className="bg-gray-100 dark:bg-gray-700 p-4 rounded-lg mb-6 text-gray-800 dark:text-gray-200 font-medium italic text-center relative">
                            "{promoContent}"
                            <div className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-4 h-4 bg-gray-100 dark:bg-gray-700 rotate-45"></div>
                        </div>

                        <div className="flex gap-3">
                            <button 
                                onClick={() => setPromoContent(null)}
                                className="flex-1 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg font-medium"
                            >
                                Close
                            </button>
                            <button 
                                onClick={handleShare}
                                className="flex-1 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg font-bold shadow-md flex items-center justify-center gap-2"
                            >
                                <ShareIcon className="w-4 h-4" />
                                Share
                            </button>
                        </div>
                    </div>
                </div>
            )}

             {isGeneratingPromo && (
                <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center backdrop-blur-sm">
                    <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-xl flex flex-col items-center">
                        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600 mb-4"></div>
                        <p className="text-gray-900 dark:text-white font-medium">Writing magic content...</p>
                    </div>
                </div>
            )}
        </div>
    );
};

export default BusinessPilot;
