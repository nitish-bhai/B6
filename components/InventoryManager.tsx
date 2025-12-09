import React, { useState, useRef, useEffect, useCallback } from 'react';
import { LiveServerMessage, Blob as GenaiBlob, FunctionCall } from '@google/genai';
import { INITIATE_ADD_ITEM_TOOL, PROVIDE_ITEM_QUANTITY_TOOL, PROVIDE_ITEM_PRICE_TOOL, REMOVE_ITEM_TOOL, QUERY_INVENTORY_TOOL, PROVIDE_ITEM_EXPIRY_DATE_TOOL, BULK_ACTION_TOOL, UPDATE_ITEM_TOOL, PLAN_LIMITS } from '../constants';
import { useAuth } from '../hooks/useAuth';
import { useInventory } from '../hooks/useInventory';
import InventoryTable from './InventoryTable';
import MicButton from './MicButton';
import CameraCapture from './CameraCapture';
import EditItemModal from './EditItemModal';
import AddItemModal from './AddItemModal';
import BusinessPilot from './BusinessPilot';
import SubscriptionModal from './SubscriptionModal';
import { encode, decode, decodeAudioData } from '../utils/audioUtils';
import { getAi } from '../services/geminiService';
import { addOrUpdateItem, removeItem, updateInventoryItem, deleteItemsBatch, saveShelfAnalysis, getShelfAnalyses, findItemByName } from '../services/inventoryService';
import { uploadImageToImgbb } from '../services/imageService';
import { getChatsStream } from '../services/chatService';
import { getNotificationsStream } from '../services/notificationService';
import { incrementUserUsage } from '../services/firebase';
import { LogoutIcon, SearchIcon, ChatIcon, BellIcon, CameraIcon, XMarkIcon, DocumentTextIcon, PresentationChartLineIcon, PlusIcon, Cog6ToothIcon } from './icons';
import { InventoryItem, Chat, Notification, ShelfAnalysis } from '../types';
import { ChatParams } from '../App';
import ChatListModal from './ChatListModal';
import Toast from './Toast';
import { Timestamp } from 'firebase/firestore';
import AudioVisualizer from './AudioVisualizer';

interface InventoryManagerProps {
    onNavigateToChat: (params: ChatParams) => void;
    onOpenNotifications: () => void;
    onViewAnalysis: (analysisId: string) => void;
}

interface DetectedItem {
    name: string;
    quantity: number;
    price: number;
    expiryDate: string;
}

const InventoryManager: React.FC<InventoryManagerProps> = ({ onNavigateToChat, onOpenNotifications, onViewAnalysis }) => {
    const { user, userProfile, logOut, updateUserProfileState } = useAuth();
    const { inventory, loading: inventoryLoading } = useInventory();
    
    const [isListening, setIsListening] = useState(false);
    const [isGreeting, setIsGreeting] = useState(false);
    const [statusText, setStatusText] = useState("Tap the mic to manage your stock, or use the camera.");
    const [searchTerm, setSearchTerm] = useState('');
    const [isChatModalOpen, setIsChatModalOpen] = useState(false);
    const [totalUnreadChatCount, setTotalUnreadChatCount] = useState(0);
    const [totalUnreadNotificationCount, setTotalUnreadNotificationCount] = useState(0);
    
    const [isCameraOpen, setIsCameraOpen] = useState(false);
    const [cameraMode, setCameraMode] = useState<'item' | 'invoice' | 'shelf-analysis'>('item');
    
    const [isAnalyzingImage, setIsAnalyzingImage] = useState(false);
    const [toastMessage, setToastMessage] = useState('');
    
    const [reviewItems, setReviewItems] = useState<DetectedItem[]>([]);
    const [isReviewingInvoice, setIsReviewingInvoice] = useState(false); 
    const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
    const [showAddItemModal, setShowAddItemModal] = useState(false);

    // History State
    const [showAnalysisHistory, setShowAnalysisHistory] = useState(false);
    const [analysisHistory, setAnalysisHistory] = useState<ShelfAnalysis[]>([]);
    
    const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
    const [bulkPromoContent, setBulkPromoContent] = useState<string | null>(null);
    const [isGeneratingBulkPromo, setIsGeneratingBulkPromo] = useState(false);

    const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);

    // Hands-Free / Wake Word State
    const [showWakeWordSettings, setShowWakeWordSettings] = useState(false);
    const [isHandsFreeMode, setIsHandsFreeMode] = useState(false);
    const [wakeWord, setWakeWord] = useState('Hey Pilot');
    const recognitionRef = useRef<any>(null); // For SpeechRecognition instance

    // State to hold the active stream for visualization
    const [activeStream, setActiveStream] = useState<MediaStream | null>(null);

    const selectedItemIdsRef = useRef<Set<string>>(new Set());
    const inventoryRef = useRef<InventoryItem[]>([]);

    useEffect(() => {
        selectedItemIdsRef.current = selectedItemIds;
    }, [selectedItemIds]);

    useEffect(() => {
        inventoryRef.current = inventory;
    }, [inventory]);

    const [transcript, setTranscript] = useState<{ speaker: 'user' | 'assistant', text: string }[]>([]);
    const transcriptEndRef = useRef<HTMLDivElement>(null);

    const awaitingPriceInfoRef = useRef<any | null>(null);
    const awaitingQuantityInfoRef = useRef<any | null>(null);
    const awaitingExpiryInfoRef = useRef<any | null>(null);

    const sessionRef = useRef<Promise<any> | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const inputAudioContextRef = useRef<AudioContext | null>(null);
    const outputAudioContextRef = useRef<AudioContext | null>(null);
    const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
    const isSessionActiveRef = useRef(false);
    const audioPlaybackTimeRef = useRef(0);
    const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
    const greetingAudioSourceRef = useRef<AudioBufferSourceNode | null>(null);
    
    useEffect(() => {
        if (!user) return;
        const unsubChats = getChatsStream(user.uid, (chats: Chat[]) => {
            const unreadSum = chats.reduce((sum, chat) => sum + (chat.unreadCount[user.uid] || 0), 0);
            setTotalUnreadChatCount(unreadSum);
        });
        const unsubNotifications = getNotificationsStream(user.uid, (notifications: Notification[]) => {
            const unreadSum = notifications.filter(n => !n.read).length;
            setTotalUnreadNotificationCount(unreadSum);
        });
        return () => {
            unsubChats();
            unsubNotifications();
        };
    }, [user]);

    useEffect(() => {
        transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [transcript]);

    useEffect(() => {
        if (showAnalysisHistory && user) {
            getShelfAnalyses(user.uid).then(setAnalysisHistory);
        }
    }, [showAnalysisHistory, user]);

    // Wake Word Detection Effect
    useEffect(() => {
        // Cleanup existing recognition
        if (recognitionRef.current) {
            recognitionRef.current.stop();
            recognitionRef.current = null;
        }

        // Only run if Hands-Free is ON and we are NOT currently in an active AI session
        if (!isHandsFreeMode || isListening || isGreeting || isSessionActiveRef.current) {
            return;
        }

        const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        
        if (!SpeechRecognition) {
            console.warn("Speech Recognition API not supported in this browser.");
            return;
        }

        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = false;
        recognition.lang = 'en-US'; // Or match user locale

        recognition.onresult = (event: any) => {
            const lastResultIndex = event.results.length - 1;
            const transcriptText = event.results[lastResultIndex][0].transcript.trim().toLowerCase();
            const targetWakeWord = wakeWord.trim().toLowerCase();

            // Check if the transcript contains the wake word
            if (transcriptText.includes(targetWakeWord)) {
                console.log("Wake word detected:", transcriptText);
                recognition.stop(); // Stop listening for wake word
                startAndGreetSession(); // Start actual AI session
            }
        };

        recognition.onerror = (event: any) => {
            console.error("Wake word recognition error", event.error);
        };

        recognition.onend = () => {
            // Restart if we should still be listening (and not starting a session)
            if (isHandsFreeMode && !isSessionActiveRef.current) {
                try {
                    recognition.start();
                } catch (e) {
                    // Ignore start errors if already started
                }
            }
        };

        try {
            recognition.start();
            recognitionRef.current = recognition;
        } catch (e) {
            console.error("Failed to start wake word listener", e);
        }

        return () => {
            if (recognitionRef.current) {
                recognitionRef.current.stop();
                recognitionRef.current = null;
            }
        };
    }, [isHandsFreeMode, isListening, isGreeting, wakeWord]); // Re-run if these change

    const checkUsageLimit = (feature: 'aiScans' | 'promosGenerated' | 'inventoryCount', currentCount: number): boolean => {
        if (!userProfile) return false;
        if (userProfile.plan === 'pro') return true; 
        const limit = PLAN_LIMITS.free[feature === 'inventoryCount' ? 'maxInventoryItems' : feature === 'aiScans' ? 'maxAiScans' : 'maxPromos'];
        if (currentCount >= limit) {
            setShowSubscriptionModal(true);
            return false;
        }
        return true;
    };

    const handleIncrementUsage = async (feature: 'aiScans' | 'promosGenerated') => {
        if (!user || !userProfile) return;
        const newCount = (userProfile.usage?.[feature] || 0) + 1;
        updateUserProfileState({ usage: { ...userProfile.usage, [feature]: newCount } });
        await incrementUserUsage(user.uid, feature);
    };

    const handleToolCall = useCallback(async (fc: FunctionCall, session: any): Promise<void> => {
        if (!user || !userProfile || !fc.args) return;
        let result: any = { success: false, message: "Sorry, I couldn't do that." };
        const userCategories = userProfile.categories || [];
        
        // Safe args casting
        const args = fc.args as any;

        switch (fc.name) {
            case 'initiateAddItem': {
                const { itemName, quantity } = args;
                if (quantity) {
                    awaitingPriceInfoRef.current = { itemName, quantity };
                    result = { success: true, message: `Okay, adding ${quantity} ${itemName}. How much does one cost?` };
                } else {
                    awaitingQuantityInfoRef.current = { itemName };
                    result = { success: true, message: `Okay, you want to add ${itemName}. How many?` };
                }
                break;
            }
            case 'provideItemQuantity': {
                if (awaitingQuantityInfoRef.current) {
                    const { itemName } = awaitingQuantityInfoRef.current;
                    const { quantity } = args;
                    awaitingPriceInfoRef.current = { itemName, quantity };
                    awaitingQuantityInfoRef.current = null;
                    result = { success: true, message: `Got it, ${quantity}. And how much is one in rupees?` };
                } else {
                    result = { success: false, message: "I'm sorry, I don't know which item you're providing the quantity for." };
                }
                break;
            }
            case 'provideItemPrice': {
                if (awaitingPriceInfoRef.current) {
                    const { itemName, quantity } = awaitingPriceInfoRef.current;
                    const { price } = args;
                    awaitingPriceInfoRef.current = null;
                    const needsExpiry = userCategories.some(cat => ['medical', 'grocery', 'sweets'].includes(cat));
                    if (!checkUsageLimit('inventoryCount', inventoryRef.current.length)) {
                         result = { success: false, message: "Inventory limit reached. Upgrade to add more items." };
                    } else {
                        if (needsExpiry) {
                            awaitingExpiryInfoRef.current = { itemName, quantity, price };
                            result = { success: true, message: `Price set. What is the expiry date? (DD-MM-YYYY)` };
                        } else {
                            await addOrUpdateItem(user.uid, itemName, quantity, price);
                            result = { success: true, message: `Great, added ${quantity} ${itemName}.` };
                        }
                    }
                } else {
                    result = { success: false, message: "I don't know which item you're providing the price for." };
                }
                break;
            }
            case 'provideItemExpiryDate': {
                 if (awaitingExpiryInfoRef.current) {
                    const { itemName, quantity, price } = awaitingExpiryInfoRef.current;
                    const { expiryDate } = args;
                    if (!/^\d{2}-\d{2}-\d{4}$/.test(expiryDate)) {
                        result = { success: false, message: "Please provide the date in Day-Month-Year format." };
                    } else {
                        if (!checkUsageLimit('inventoryCount', inventoryRef.current.length)) {
                            result = { success: false, message: "Inventory limit reached." };
                        } else {
                            await addOrUpdateItem(user.uid, itemName, quantity, price, expiryDate);
                            result = { success: true, message: `Added ${itemName} with expiry ${expiryDate}.` };
                            awaitingExpiryInfoRef.current = null;
                        }
                    }
                } else {
                    result = { success: false, message: "I don't know which item needs an expiry." };
                }
                break;
            }
            case 'updateItem': {
                const { itemName, newPrice, newQuantity } = args;
                const foundItem = await findItemByName(user.uid, itemName);
                if (!foundItem) {
                     result = { success: false, message: `I couldn't find ${itemName} in your inventory to update.` };
                } else {
                     const updates: Partial<InventoryItem> = {};
                     if (newPrice !== undefined) updates.price = newPrice;
                     if (newQuantity !== undefined) updates.quantity = newQuantity;
                     
                     if (Object.keys(updates).length > 0) {
                        await updateInventoryItem(user.uid, foundItem.id, updates);
                        result = { success: true, message: `Updated ${itemName}.` };
                     } else {
                        result = { success: false, message: `What would you like to update for ${itemName}?` };
                     }
                }
                break;
            }
            case 'removeItem': {
                const removeResult = await removeItem(user.uid, args.itemName, args.quantity);
                result = { success: removeResult.success, message: removeResult.message };
                break;
            }
            case 'queryInventory': {
                // Pre-calculate totals to ensure accuracy (LLMs often fail at arithmetic on long lists)
                const items = inventoryRef.current;
                const totalValue = items.reduce((acc, item) => acc + (item.quantity * item.price), 0);
                const totalCount = items.reduce((acc, item) => acc + item.quantity, 0);

                const inventoryList = items.map(i => 
                    `Item: ${i.name}, Qty: ${i.quantity}, Price: ${i.price}, Expiry: ${i.expiryDate || 'N/A'}`
                ).join('; ');

                const message = inventoryList 
                    ? `Here is the current database summary:
                       - Total Inventory Value: ₹${totalValue}
                       - Total Items Count: ${totalCount} units
                       
                       Detailed List Data: [${inventoryList}]. 
                       
                       Use these pre-calculated totals to answer questions about value or count. Do not try to sum them yourself. Do not hallucinate.` 
                    : "The inventory is currently empty.";
                
                result = { success: true, message };
                break;
            }
            case 'performBulkAction': {
                const { actionType } = args;
                const currentSelection = selectedItemIdsRef.current;
                
                if (actionType === 'deselect') {
                    setSelectedItemIds(new Set());
                    result = { success: true, message: "Selection cleared." };
                } else if (currentSelection.size === 0) {
                    result = { success: false, message: "No items selected." };
                } else {
                    if (actionType === 'delete') {
                         try {
                            await deleteItemsBatch(user.uid, Array.from(currentSelection));
                            setSelectedItemIds(new Set());
                            result = { success: true, message: `Deleted ${currentSelection.size} items.` };
                        } catch (e) {
                            result = { success: false, message: "Failed to delete items." };
                        }
                    } else if (actionType === 'promote') {
                         const currentPromos = userProfile.usage?.promosGenerated || 0;
                         if (!checkUsageLimit('promosGenerated', currentPromos)) {
                             result = { success: false, message: "Promo limit reached. Upgrade for more." };
                         } else {
                             setIsGeneratingBulkPromo(true);
                             const selectedItems = inventoryRef.current.filter(i => currentSelection.has(i.id));
                             const itemNames = selectedItems.map(i => i.name).join(", ");
                             
                             const ai = getAi();
                             const prompt = `Create a WhatsApp promo for bundle: ${itemNames}. Discount? Emojis. Short.`;

                             ai.models.generateContent({
                                model: 'gemini-2.5-flash',
                                contents: prompt
                            }).then(res => {
                                setBulkPromoContent(res.text || null);
                                setIsGeneratingBulkPromo(false);
                                handleIncrementUsage('promosGenerated');
                            });
                            
                            result = { success: true, message: `Generating promo for ${currentSelection.size} items.` };
                         }
                    }
                }
                break;
            }
        }

        session.sendToolResponse({
            functionResponses: [{
                id: fc.id,
                name: fc.name,
                response: { result: result.message },
            }]
        });
    }, [user, userProfile]);

    const stopSession = useCallback(() => {
        if (!isSessionActiveRef.current) return;
        isSessionActiveRef.current = false;
    
        if (greetingAudioSourceRef.current) {
            try { greetingAudioSourceRef.current.stop(); } catch(e) {}
            greetingAudioSourceRef.current = null;
        }

        setIsListening(false);
        setIsGreeting(false);
        setActiveStream(null); // Stop visualizer
        setStatusText(prev => prev.startsWith("Microphone") ? prev : "Tap the mic to manage your stock, or use the camera.");
        
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach(track => track.stop());
            mediaStreamRef.current = null;
        }

        scriptProcessorRef.current?.disconnect();
        scriptProcessorRef.current = null;
        
        // Don't close contexts completely, just suspend to allow reuse? 
        // Better to close to release hardware on mobile, but re-creation is expensive.
        // For robustness, we close.
        inputAudioContextRef.current?.close().catch(console.error);
        inputAudioContextRef.current = null;

        outputAudioContextRef.current?.close().catch(console.error);
        outputAudioContextRef.current = null;
        
        audioSourcesRef.current.forEach(source => {
            try { source.stop(); } catch (e) { }
        });
        audioSourcesRef.current.clear();

        sessionRef.current?.then((session: any) => session.close()).catch(console.error);
        sessionRef.current = null;
        
        awaitingPriceInfoRef.current = null;
        awaitingQuantityInfoRef.current = null;
        awaitingExpiryInfoRef.current = null;
    }, []);

    const connectToGemini = async () => {
        if (!process.env.API_KEY || !user || !userProfile?.categories || !isSessionActiveRef.current) return;
        
        // Note: AudioContexts and MediaStream are already initialized in startAndGreetSession
        if (!inputAudioContextRef.current || !outputAudioContextRef.current || !mediaStreamRef.current) {
             console.error("Audio resources missing in connectToGemini");
             stopSession();
             return;
        }

        setIsListening(true);
        setStatusText("Listening... Say something.");

        const ai = getAi();
        // Dynamically insert user categories into the system instruction for strict validation
        const userCats = userProfile.categories.join(', ');
        
        const systemInstruction = `You are a bilingual inventory assistant for a shopkeeper in India. 
        1. **Language & Accent:** You understand Hindi, English, and Hinglish accents proficiently. Speak naturally.
        2. **Translation Rule:** ALWAYS translate item names to ENGLISH before calling any tool or saving to database. 
           - If user says "50 packets doodh add karo", call 'initiateAddItem' with itemName="Milk".
           - If user says "Aloo ka price 20 kar do", call 'updateItem' with itemName="Potato", newPrice=20.
        3. **Strict Category Enforcement:** The user's shop categories are: [${userCats}].
           - If the user asks to add an item that CLEARLY belongs to a different industry (e.g., adding 'Paracetamol' to a 'Grocery' shop, or 'Hammer' to a 'Medical' shop), YOU MUST REFUSE.
           - Say: "I cannot add [Item] because it doesn't belong to a [Category] store."
           - Do NOT call the 'initiateAddItem' tool for mismatched items.
        4. **Tools:** 
           - 'initiateAddItem': For NEW stock or INCREASING quantity (Category Checked).
           - 'updateItem': For CHANGING price or quantity of EXISTING items.
           - 'removeItem': For reducing stock.
           - 'queryInventory': For answering questions about stock.
        5. **Personality:** Be concise, helpful, and confirm actions clearly.`;

        try {
            sessionRef.current = ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                config: {
                    systemInstruction,
                    // Strictly typing as 'AUDIO' to avoid Enum serialization issues
                    responseModalities: ['AUDIO'] as any,
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                    tools: [{ functionDeclarations: [INITIATE_ADD_ITEM_TOOL, PROVIDE_ITEM_QUANTITY_TOOL, PROVIDE_ITEM_PRICE_TOOL, REMOVE_ITEM_TOOL, QUERY_INVENTORY_TOOL, PROVIDE_ITEM_EXPIRY_DATE_TOOL, BULK_ACTION_TOOL, UPDATE_ITEM_TOOL] }]
                },
                callbacks: {
                    onopen: () => {
                        if (!inputAudioContextRef.current || !mediaStreamRef.current) return;
                        const source = inputAudioContextRef.current.createMediaStreamSource(mediaStreamRef.current);
                        scriptProcessorRef.current = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
                        scriptProcessorRef.current.onaudioprocess = (e) => {
                            if (!isSessionActiveRef.current) return;
                            const inputData = e.inputBuffer.getChannelData(0);
                            const pcmBlob: GenaiBlob = { data: encode(new Uint8Array(new Int16Array(inputData.map(f => f * 32768)).buffer)), mimeType: 'audio/pcm;rate=16000' };
                            sessionRef.current?.then((s: any) => s.sendRealtimeInput({ media: pcmBlob }));
                        };
                        source.connect(scriptProcessorRef.current);
                        scriptProcessorRef.current.connect(inputAudioContextRef.current.destination);
                    },
                    onmessage: async (msg: LiveServerMessage) => {
                        if (!isSessionActiveRef.current) return;

                        if (msg.serverContent?.interrupted) {
                            audioSourcesRef.current.forEach(source => {
                                try { source.stop(); } catch (e) {}
                            });
                            audioSourcesRef.current.clear();
                            if (outputAudioContextRef.current) {
                                audioPlaybackTimeRef.current = outputAudioContextRef.current.currentTime;
                            }
                        }

                        // Safely access inlineData for audio
                        const inlineData = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData;
                        if (inlineData?.data) {
                            const base64 = inlineData.data;
                            if (outputAudioContextRef.current) {
                                if (outputAudioContextRef.current.state === 'suspended') {
                                    await outputAudioContextRef.current.resume();
                                }
                                audioPlaybackTimeRef.current = Math.max(audioPlaybackTimeRef.current, outputAudioContextRef.current.currentTime);
                                const buffer = await decodeAudioData(decode(base64), outputAudioContextRef.current, 24000, 1);
                                const sourceNode = outputAudioContextRef.current.createBufferSource();
                                sourceNode.buffer = buffer;
                                sourceNode.connect(outputAudioContextRef.current.destination);
                                sourceNode.onended = () => audioSourcesRef.current.delete(sourceNode);
                                sourceNode.start(audioPlaybackTimeRef.current);
                                audioPlaybackTimeRef.current += buffer.duration;
                                audioSourcesRef.current.add(sourceNode);
                            }
                        }

                        if (msg.serverContent?.outputTranscription?.text) {
                            const text = msg.serverContent.outputTranscription.text;
                            setTranscript(prev => {
                                const last = prev[prev.length - 1];
                                if (last && last.speaker === 'assistant') {
                                    return [...prev.slice(0, -1), { ...last, text: last.text + text }];
                                }
                                return [...prev, { speaker: 'assistant', text }];
                            });
                        }

                        if (msg.serverContent?.inputTranscription?.text) {
                            const text = msg.serverContent.inputTranscription.text;
                            setTranscript(prev => {
                                const last = prev[prev.length - 1];
                                if (last && last.speaker === 'user') {
                                    return [...prev.slice(0, -1), { ...last, text: last.text + text }];
                                }
                                return [...prev, { speaker: 'user', text }];
                            });
                        }

                        if (msg.toolCall?.functionCalls) {
                            const s = await sessionRef.current;
                            if (s) msg.toolCall.functionCalls.forEach(fc => handleToolCall(fc, s));
                        }
                    },
                    onerror: (e: ErrorEvent) => { 
                        console.error("Session Error", e);
                        setStatusText("Connection Error. Tap to retry.");
                        stopSession(); 
                    },
                    onclose: () => {
                         if (isSessionActiveRef.current) stopSession();
                    },
                },
            });
        } catch (e) {
            console.error("Connection Failed", e);
            setStatusText("Failed to connect.");
            stopSession();
        }
    };

    const startAndGreetSession = async () => {
        if (!process.env.API_KEY || !user) return;
        
        if (isSessionActiveRef.current) {
            stopSession();
            return;
        }

        isSessionActiveRef.current = true;
        setIsGreeting(true);
        setTranscript([]); 
        setStatusText("Initializing...");

        // CRITICAL: Create all audio resources immediately on user gesture (click)
        try {
            // 1. Get Mic
            mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
            setActiveStream(mediaStreamRef.current); // Enable Visualizer

            // 2. Create Contexts
            outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
            inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            
            // 3. Resume immediately to unlock audio on mobile
            await outputAudioContextRef.current.resume();
            await inputAudioContextRef.current.resume();

        } catch (error: any) {
             console.error("Audio Initialization Error:", error);
             if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                 setStatusText("Microphone permission denied.");
                 setToastMessage("Please allow microphone access.");
            } else {
                 setStatusText("Audio unavailable. Check settings.");
            }
            stopSession();
            return;
        }

        setStatusText("Assistant is speaking...");
        setTranscript([{ speaker: 'assistant', text: "Hello, how can I help you?" }]);

        // 4. Generate & Play Greeting
        try {
            const ai = getAi();
            const res = await ai.models.generateContent({
                model: "gemini-2.5-flash-preview-tts", 
                // Fix: Must pass contents as structured parts for TTS model when modality is AUDIO
                contents: [{ parts: [{ text: "Hello, how can I help you?" }] }],
                config: { 
                    responseModalities: ['AUDIO'],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } 
                },
            });
            const base64 = res.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            
            if (!base64 || !outputAudioContextRef.current) throw new Error("TTS failed.");
            
            const buffer = await decodeAudioData(decode(base64), outputAudioContextRef.current, 24000, 1);
            const source = outputAudioContextRef.current.createBufferSource();
            greetingAudioSourceRef.current = source;
            source.buffer = buffer;
            source.connect(outputAudioContextRef.current.destination);
            
            source.onended = () => { 
                if (isSessionActiveRef.current) {
                    setIsGreeting(false);
                    connectToGemini();
                }
            };
            source.start();
        } catch (error) {
            console.error("Greeting failed, skipping to live", error);
            setIsGreeting(false);
            if (isSessionActiveRef.current) connectToGemini();
        }
    };
    
    const handleMicClick = () => { if (isListening || isGreeting) stopSession(); else startAndGreetSession(); };
    const handleCaptureOpen = (mode: 'item' | 'invoice' | 'shelf-analysis') => {
        const currentUsage = userProfile?.usage?.aiScans || 0;
        if (mode !== 'item' && !checkUsageLimit('aiScans', currentUsage)) { return; }
        setCameraMode(mode);
        setIsCameraOpen(true);
    };

    const handleImageCapture = async (captureData: string | string[]) => {
        setIsCameraOpen(false);
        setIsAnalyzingImage(true);
        setToastMessage('Processing view...');
        
        const isInvoice = cameraMode === 'invoice';
        const isShelfAnalysis = cameraMode === 'shelf-analysis';

        await handleIncrementUsage('aiScans');

        if (isShelfAnalysis) {
            const frames = Array.isArray(captureData) ? captureData : [captureData];
            const ai = getAi();
            
            const analysisPrompt = `Act as a visual retail expert. Analyze this sequence of shop shelf images.
             1. **Ghost Spots:** Empty spaces where product is missing.
             2. **Misplaced Items:** Items that are messy or in the wrong place.
             
             CRITICAL: For each issue, identify the specific frame index (0 to ${frames.length - 1}) that best shows it.
             Return the 2D bounding box [ymin, xmin, ymax, xmax] on a 0-1000 scale for the issue.
             
             Return purely JSON: 
             { 
               "score": number (1-10), 
               "summary": "Short text summary of findings",
               "powerMove": "One key action to improve sales",
               "visualIssues": [
                 { "label": "Empty Shelf", "type": "ghost_spot", "frameIndex": number, "box2d": [ymin, xmin, ymax, xmax], "suggestion": "Restock immediately" }
               ]
             }`;

            try {
                // Prepare all frames for analysis
                const imageParts = frames.map(base64 => ({
                    inlineData: { mimeType: 'image/jpeg', data: base64 }
                }));
                
                // Send all frames to Gemini
                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: {
                        parts: [...imageParts, { text: analysisPrompt }]
                    },
                    config: { responseMimeType: 'application/json' }
                });
                
                if (response.text) {
                    const report = JSON.parse(response.text);
                    
                    // Determine worst frame for AI Renovation
                    const issueCounts = new Array(frames.length).fill(0);
                    report.visualIssues.forEach((issue: any) => {
                        if(issue.frameIndex >= 0 && issue.frameIndex < frames.length) issueCounts[issue.frameIndex]++;
                    });
                    const worstFrameIndex = issueCounts.indexOf(Math.max(...issueCounts));
                    const frameToFix = frames[worstFrameIndex >= 0 ? worstFrameIndex : Math.floor(frames.length / 2)] || frames[0];
                    
                    setToastMessage("Generating Renovation Plan...");
                    
                    let improvedImageBase64 = null;
                    try {
                        const editResponse = await ai.models.generateContent({
                            model: 'gemini-2.5-flash-image',
                            contents: {
                                parts: [
                                    { inlineData: { mimeType: 'image/jpeg', data: frameToFix } },
                                    { text: 'Edit this shop shelf image to look perfect. Fill empty spaces with products, organize messy items to be straight, and make it look like a high-end retail display. Keep the general layout but fix the merchandising issues.' },
                                ],
                            },
                        });
                        
                        const parts = editResponse.candidates?.[0]?.content?.parts;
                        if (parts) {
                            for (const part of parts) {
                                if (part.inlineData?.data) {
                                    improvedImageBase64 = part.inlineData.data;
                                    break;
                                }
                            }
                        }
                    } catch(e) { console.error("Image generation failed", e); }

                    if (user) {
                        setToastMessage("Uploading frames to cloud...");
                        
                        // Upload ALL frames in parallel to ImgBB
                        const uploadPromises = frames.map(frame => uploadImageToImgbb(frame));
                        const uploadedUrls = await Promise.all(uploadPromises);
                        const validUrls = uploadedUrls.filter(url => url !== null) as string[];

                        if (validUrls.length === 0) {
                            setToastMessage("Image upload failed. Analysis not saved.");
                            setIsAnalyzingImage(false);
                            return;
                        }

                        // Determine primary URL (worst frame)
                        const primaryUrl = (worstFrameIndex >= 0 && worstFrameIndex < validUrls.length) ? validUrls[worstFrameIndex] : validUrls[0];

                        // Upload Improved Frame
                        let improvedUrl: string | null = null;
                        if (improvedImageBase64) {
                            improvedUrl = await uploadImageToImgbb(improvedImageBase64);
                        }

                        const analysisData: any = {
                            userId: user.uid,
                            createdAt: Timestamp.now(),
                            score: report.score,
                            summary: report.summary,
                            powerMove: report.powerMove,
                            visualIssues: report.visualIssues,
                            capturedFrame: primaryUrl, 
                            capturedFrames: validUrls // Save full sequence
                        };

                        // Conditionally add improvedFrame to avoid 'undefined' error in Firestore
                        if (improvedUrl) {
                            analysisData.improvedFrame = improvedUrl;
                        }

                        const newAnalysisId = await saveShelfAnalysis(analysisData);
                        
                        onViewAnalysis(newAnalysisId);
                    }
                }
            } catch (err) {
                console.error("Analysis failed", err);
                setToastMessage("Could not analyze shelf.");
            } finally {
                setIsAnalyzingImage(false);
            }
            return;
        }

        // --- Standard Invoice/Item Scan Logic ---
        setIsReviewingInvoice(isInvoice);
        const base64Image = Array.isArray(captureData) ? captureData[0] : captureData;
        
        const today = new Date().toLocaleDateString('en-GB'); // DD/MM/YYYY
        const promptSuffix = `
            Return a JSON Array of objects: [{ "name": string, "quantity": number, "price": number, "expiryDate": string }].
            CRITICAL RULES:
            1. If price is missing, ESTIMATE a realistic Indian market price in INR.
            2. If expiry date is missing, ESTIMATE it based on the item type (e.g., Vegetables: +3 days, Milk: +2 days, Rice: +1 year, Medicine: +2 years) starting from today: ${today}. Format must be DD-MM-YYYY.
            3. Translate names to English.
        `;
        
        const snapPrompt = `Analyze this inventory image. Identify items. ${promptSuffix}`;
        const invoicePrompt = `Analyze this invoice. Extract items. ${promptSuffix}`;

        try {
            const ai = getAi();
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: {
                    parts: [{ inlineData: { mimeType: 'image/jpeg', data: base64Image } }, { text: isInvoice ? invoicePrompt : snapPrompt }]
                },
                config: { responseMimeType: 'application/json' }
            });

            if (response.text) {
                const data = JSON.parse(response.text);
                const items = Array.isArray(data) ? data : [data];
                setReviewItems(items);
                if (items.length === 0) setToastMessage('No items detected.');
            }
        } catch (err) {
            setToastMessage('Failed to analyze image.');
        } finally {
            setIsAnalyzingImage(false);
        }
    };

    const handleManualAddItem = async (itemData: { name: string; quantity: number; price: number; expiryDate?: string }) => {
        if (!user || !userProfile) return;
        if (!checkUsageLimit('inventoryCount', inventoryRef.current.length)) {
            setToastMessage("Inventory limit reached.");
            return;
        }

        setToastMessage("Validating item...");
        
        // Manual Category Validation using Gemini Flash (Fast)
        try {
            const ai = getAi();
            const categoriesStr = userProfile.categories.join(', ');
            const prompt = `Can a store with these categories: [${categoriesStr}] sell "${itemData.name}"? Answer STRICTLY 'YES' or 'NO'.`;
            
            const result = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt
            });
            
            const response = result.text?.trim().toUpperCase();
            
            if (response && response.includes('NO')) {
                setToastMessage(`Cannot add "${itemData.name}". It does not match your store categories (${categoriesStr}).`);
                return; // Block addition
            }
        } catch (e) {
            console.error("Validation failed, proceeding loosely", e);
        }

        try {
            await addOrUpdateItem(user.uid, itemData.name, itemData.quantity, itemData.price, itemData.expiryDate);
            setShowAddItemModal(false);
            setToastMessage(`Added ${itemData.name} successfully.`);
        } catch (e) {
            setToastMessage("Failed to add item.");
        }
    };

    const handleUpdateItem = async (updatedItem: InventoryItem) => {
        if (!user) return;
        try {
            await updateInventoryItem(user.uid, updatedItem.id, updatedItem);
            setEditingItem(null);
            setToastMessage(`Updated ${updatedItem.name} successfully.`);
        } catch (error) {
            setToastMessage("Failed to update item.");
        }
    };

    const handleConfirmReview = async () => {
        if (!user || reviewItems.length === 0) return;
        try {
            for (const item of reviewItems) {
                await addOrUpdateItem(user.uid, item.name, item.quantity, item.price, item.expiryDate);
            }
            setReviewItems([]);
            setToastMessage(`Successfully added items!`);
        } catch (err) {
            setToastMessage('Failed to save items.');
        }
    };

    const updateReviewItem = (index: number, field: keyof DetectedItem, value: any) => {
        const newItems = [...reviewItems];
        newItems[index] = { ...newItems[index], [field]: value };
        setReviewItems(newItems);
    };
    const removeReviewItem = (index: number) => setReviewItems(reviewItems.filter((_, i) => i !== index));

    const handleBulkDelete = async () => {
        if (!user || selectedItemIds.size === 0) return;
        if (window.confirm(`Delete ${selectedItemIds.size} items?`)) {
            try {
                await deleteItemsBatch(user.uid, Array.from(selectedItemIds));
                setSelectedItemIds(new Set());
                setToastMessage('Items deleted.');
            } catch (error) {
                setToastMessage('Failed to delete.');
            }
        }
    };

    const handleBulkPromo = async () => {
        const currentPromos = userProfile?.usage?.promosGenerated || 0;
        if (!checkUsageLimit('promosGenerated', currentPromos)) return;
        if (selectedItemIds.size === 0) return;
        setIsGeneratingBulkPromo(true);
        const selectedItems = inventory.filter(i => selectedItemIds.has(i.id));
        const itemNames = selectedItems.map(i => i.name).join(", ");
        const ai = getAi();
        const prompt = `Create a WhatsApp promo for bundle: ${itemNames}. Discount? Emojis. Short.`;
        try {
            const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
            setBulkPromoContent(response.text || null);
            await handleIncrementUsage('promosGenerated');
        } catch (error) { setToastMessage("Failed to generate promo."); } finally { setIsGeneratingBulkPromo(false); }
    };

    const filteredInventory = inventory.filter(item => {
        const term = searchTerm.toLowerCase();
        return (
            item.name.toLowerCase().includes(term) ||
            item.quantity.toString().includes(term) ||
            item.price.toString().includes(term) ||
            (item.expiryDate && item.expiryDate.includes(term))
        );
    });
    const totalItems = inventory.reduce((acc, item) => acc + item.quantity, 0);
    const totalValue = inventory.reduce((acc, item) => acc + (item.quantity * item.price), 0);

    return (
        <main className="container mx-auto p-4 md:p-8 pb-24">
            <Toast message={toastMessage} onClose={() => setToastMessage('')} />
            {/* ... Header & Business Pilot (Same as original) ... */}
            <header className="flex flex-col md:flex-row justify-between items-center mb-8 gap-4">
                <div>
                    <h1 className="text-3xl md:text-4xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
                    <p className="text-gray-500 dark:text-gray-400">Welcome, {userProfile?.name}</p>
                    <div className="mt-2 flex items-center gap-2">
                        {userProfile?.plan === 'pro' ? (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gradient-to-r from-indigo-600 to-purple-600 text-white">Vyapar Pro 🚀</span>
                        ) : (
                            <button onClick={() => setShowSubscriptionModal(true)} className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200">Free Plan ({userProfile?.usage?.aiScans || 0}/{PLAN_LIMITS.free.maxAiScans} Scans)</button>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <button onClick={() => setShowAnalysisHistory(true)} className="p-3 bg-gray-200 dark:bg-gray-700 rounded-full hover:bg-gray-300 dark:hover:bg-gray-600" title="Scan History"><PresentationChartLineIcon className="w-5 h-5 text-gray-500 dark:text-white" /></button>
                    <button onClick={onOpenNotifications} className="relative p-3 bg-gray-200 dark:bg-gray-700 rounded-full"><BellIcon className="w-5 h-5" />{totalUnreadNotificationCount > 0 && <span className="absolute top-0 right-0 h-5 w-5 bg-red-500 text-white text-xs flex items-center justify-center rounded-full">{totalUnreadNotificationCount}</span>}</button>
                    <button onClick={() => setIsChatModalOpen(true)} className="relative p-3 bg-gray-200 dark:bg-gray-700 rounded-full"><ChatIcon className="w-5 h-5" />{totalUnreadChatCount > 0 && <span className="absolute top-0 right-0 h-5 w-5 bg-red-500 text-white text-xs flex items-center justify-center rounded-full">{totalUnreadChatCount}</span>}</button>
                    <button onClick={logOut} className="p-3 bg-gray-200 dark:bg-gray-700 rounded-full"><LogoutIcon className="w-5 h-5" /></button>
                </div>
            </header>

            <BusinessPilot inventory={inventory} onIncrementUsage={handleIncrementUsage} />

            <section className="mb-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {/* 1. Voice Assistant Card */}
                <div className="bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl p-6 text-white shadow-lg relative overflow-hidden h-48 md:h-auto flex flex-col justify-between">
                     {/* Visualizer Background */}
                     {(isListening || isGreeting) && (
                        <AudioVisualizer stream={activeStream} isActive={isListening || isGreeting} />
                     )}
                     
                    <div className="relative z-10 flex justify-between items-start">
                        <div>
                            <h2 className="text-lg font-semibold mb-1">Voice Assistant</h2>
                            <p className="text-indigo-100 text-sm h-12 overflow-hidden">{statusText}</p>
                        </div>
                        {/* Settings Cog */}
                        <button onClick={() => setShowWakeWordSettings(true)} className="p-2 text-white/70 hover:text-white transition-colors">
                            <Cog6ToothIcon className="w-5 h-5" />
                        </button>
                    </div>
                    
                    <div className="absolute bottom-4 right-4 z-20 flex gap-2 items-center">
                        {isHandsFreeMode && (
                            <span className="text-[10px] bg-white/20 px-2 py-1 rounded text-white animate-pulse">
                                Listening for "{wakeWord}"
                            </span>
                        )}
                        <MicButton isListening={isListening || isGreeting} onClick={handleMicClick} />
                    </div>
                    {(isListening || isGreeting) && !activeStream && <div className="absolute top-0 left-0 w-full h-full flex items-center justify-center pointer-events-none"><span className="animate-ping absolute inline-flex h-32 w-32 rounded-full bg-white opacity-10"></span></div>}
                </div>
                
                {/* 2. Transcript - Now in slot 2 */}
                <div className="bg-white dark:bg-gray-800 rounded-xl p-6 shadow-md border border-gray-200 dark:border-gray-700 flex flex-col">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Transcript</h2>
                    <div className="h-32 overflow-y-auto text-sm space-y-2 custom-scrollbar">
                        {transcript.length === 0 ? (
                            <p className="text-gray-400 text-xs italic text-center mt-10">Conversation history will appear here.</p>
                        ) : (
                            transcript.map((entry, i) => (
                                <div key={i} className={entry.speaker === 'user' ? 'text-right' : 'text-left'}>
                                    <span className={`inline-block px-3 py-1 rounded-lg ${entry.speaker === 'user' ? 'bg-indigo-100 dark:bg-indigo-900/30' : 'bg-gray-100 dark:bg-gray-700'}`}>{entry.text}</span>
                                </div>
                            ))
                        )}
                        <div ref={transcriptEndRef} />
                    </div>
                </div>

                {/* 3. Visual AI Tools - Now in slot 3 with responsive spanning */}
                <div className="bg-white dark:bg-gray-800 rounded-xl p-6 shadow-md border border-gray-200 dark:border-gray-700 flex flex-col justify-between md:col-span-2 lg:col-span-1">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Visual AI Tools</h2>
                    <div className="grid grid-cols-3 gap-2">
                        <button onClick={() => handleCaptureOpen('item')} className="flex flex-col items-center justify-center p-2 rounded-lg bg-gray-50 dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors group"><div className="p-2 bg-indigo-100 dark:bg-indigo-900 rounded-full mb-1"><CameraIcon className="w-5 h-5 text-indigo-600 dark:text-indigo-400" /></div><span className="text-xs font-medium text-gray-700 dark:text-gray-300">Snap Item</span></button>
                        <button onClick={() => handleCaptureOpen('invoice')} className="flex flex-col items-center justify-center p-2 rounded-lg bg-gray-50 dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors group relative">{userProfile?.plan !== 'pro' && <div className="absolute top-1 right-1 w-2 h-2 bg-yellow-400 rounded-full" />}<div className="p-2 bg-green-100 dark:bg-green-900 rounded-full mb-1"><DocumentTextIcon className="w-5 h-5 text-green-600 dark:text-green-400" /></div><span className="text-xs font-medium text-gray-700 dark:text-gray-300">Scan Bill</span></button>
                        <button onClick={() => handleCaptureOpen('shelf-analysis')} className="flex flex-col items-center justify-center p-2 rounded-lg bg-gray-50 dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors group relative">{userProfile?.plan !== 'pro' && <div className="absolute top-1 right-1 w-2 h-2 bg-yellow-400 rounded-full" />}<div className="p-2 bg-purple-100 dark:bg-purple-900 rounded-full mb-1"><PresentationChartLineIcon className="w-5 h-5 text-purple-600 dark:text-purple-400" /></div><span className="text-xs font-medium text-gray-700 dark:text-gray-300">Shelf Doctor</span></button>
                    </div>
                </div>
            </section>

            <div className="flex flex-col md:flex-row justify-between items-center mb-6 gap-4">
                <div className="flex items-center bg-white dark:bg-gray-800 p-2 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 w-full md:max-w-md"><SearchIcon className="w-5 h-5 text-gray-400 ml-2" /><input type="text" placeholder="Search inventory..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="w-full bg-transparent border-none focus:ring-0 text-gray-900 dark:text-white ml-2" /></div>
                <button onClick={() => setShowAddItemModal(true)} className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors shadow-sm w-full md:w-auto justify-center"><PlusIcon className="w-5 h-5" />Add Item Manually</button>
            </div>

            <InventoryTable items={filteredInventory} loading={inventoryLoading} totalItems={totalItems} totalValue={totalValue} onStartChat={() => setIsChatModalOpen(true)} onAddItemClick={() => startAndGreetSession()} onEdit={setEditingItem} selectedItems={selectedItemIds} onSelectionChange={setSelectedItemIds} onBulkDelete={handleBulkDelete} onBulkPromo={handleBulkPromo} />

            {/* Modals */}
            {isChatModalOpen && userProfile && <ChatListModal currentUserProfile={userProfile} onClose={() => setIsChatModalOpen(false)} onNavigateToChat={onNavigateToChat} />}
            {isCameraOpen && <CameraCapture onCapture={handleImageCapture} onClose={() => setIsCameraOpen(false)} mode={cameraMode} />}
            {isAnalyzingImage && <div className="fixed inset-0 bg-black bg-opacity-60 z-50 flex items-center justify-center"><div className="bg-white dark:bg-gray-800 p-8 rounded-xl shadow-2xl flex flex-col items-center"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mb-4"></div><p className="text-lg font-semibold text-gray-900 dark:text-white">AI is analyzing...</p></div></div>}

            {/* Wake Word Settings Modal */}
            {showWakeWordSettings && (
                <div className="fixed inset-0 bg-black bg-opacity-60 z-50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setShowWakeWordSettings(false)}>
                    <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-2xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
                        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-4">Voice Settings</h3>
                        
                        <div className="flex items-center justify-between mb-6">
                            <div>
                                <p className="font-semibold text-gray-900 dark:text-white">Hands-Free Mode</p>
                                <p className="text-xs text-gray-500">Listen for wake word</p>
                            </div>
                            <button 
                                onClick={() => setIsHandsFreeMode(!isHandsFreeMode)}
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isHandsFreeMode ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-gray-700'}`}
                            >
                                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isHandsFreeMode ? 'translate-x-6' : 'translate-x-1'}`} />
                            </button>
                        </div>

                        {isHandsFreeMode && (
                            <div className="mb-6">
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Wake Word / Phrase</label>
                                <input 
                                    type="text" 
                                    value={wakeWord}
                                    onChange={(e) => setWakeWord(e.target.value)}
                                    className="w-full rounded-md border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500"
                                    placeholder="e.g. Hey Pilot"
                                />
                                <p className="text-xs text-gray-500 mt-1">Say this phrase to start talking automatically.</p>
                            </div>
                        )}

                        <div className="flex justify-end">
                            <button 
                                onClick={() => setShowWakeWordSettings(false)}
                                className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
                            >
                                Done
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Scan History Modal */}
            {showAnalysisHistory && (
                <div className="fixed inset-0 bg-black bg-opacity-60 z-50 flex items-center justify-center backdrop-blur-sm p-4">
                    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-2xl h-[80vh] flex flex-col overflow-hidden border border-gray-200 dark:border-gray-700">
                        <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
                            <h2 className="text-xl font-bold text-gray-900 dark:text-white">Shelf Analysis History</h2>
                            <button onClick={() => setShowAnalysisHistory(false)} className="text-gray-500 hover:text-gray-700"><XMarkIcon className="w-6 h-6" /></button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 space-y-4">
                            {analysisHistory.length === 0 ? (
                                <p className="text-center text-gray-500 mt-10">No past analyses found.</p>
                            ) : (
                                analysisHistory.map(analysis => (
                                    <div key={analysis.id} onClick={() => { setShowAnalysisHistory(false); onViewAnalysis(analysis.id); }} className="bg-gray-50 dark:bg-gray-700/30 p-4 rounded-lg border border-gray-200 dark:border-gray-600 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-4">
                                        <img 
                                            src={analysis.capturedFrame.startsWith('http') ? analysis.capturedFrame : `data:image/jpeg;base64,${analysis.capturedFrame}`} 
                                            className="w-16 h-16 object-cover rounded-md" 
                                            alt="Thumbnail" 
                                        />
                                        <div className="flex-1">
                                            <div className="flex justify-between">
                                                <h3 className="font-bold text-gray-900 dark:text-white">Score: {analysis.score}/10</h3>
                                                <span className="text-xs text-gray-500">{analysis.createdAt.toDate().toLocaleDateString()}</span>
                                            </div>
                                            <p className="text-sm text-gray-600 dark:text-gray-300 line-clamp-2">{analysis.summary}</p>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ... other modals ... */}
            {reviewItems.length > 0 && (
                <div className="fixed inset-0 bg-black bg-opacity-60 z-50 flex items-center justify-center backdrop-blur-sm p-4">
                    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
                        <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center"><div><h2 className="text-xl font-bold text-gray-900 dark:text-white">Review {isReviewingInvoice ? 'Invoice' : 'Detected'} Items</h2></div><button onClick={() => setReviewItems([])} className="text-gray-400 hover:text-gray-600"><XMarkIcon className="w-6 h-6" /></button></div>
                        <div className="flex-1 overflow-y-auto p-6"><div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{reviewItems.map((item, idx) => (<div key={idx} className="bg-gray-50 dark:bg-gray-700/50 p-4 rounded-lg border relative group"><button onClick={() => removeReviewItem(idx)} className="absolute top-2 right-2 text-red-600 opacity-0 group-hover:opacity-100"><XMarkIcon className="w-4 h-4" /></button><div className="space-y-2"><input value={item.name} onChange={(e) => updateReviewItem(idx, 'name', e.target.value)} className="w-full bg-transparent border-b font-bold" /><div className="flex gap-2"><input type="number" value={item.quantity} onChange={(e) => updateReviewItem(idx, 'quantity', parseInt(e.target.value))} className="w-1/2 bg-transparent border-b" /><input type="number" value={item.price} onChange={(e) => updateReviewItem(idx, 'price', parseFloat(e.target.value))} className="w-1/2 bg-transparent border-b" /></div><input value={item.expiryDate} onChange={(e) => updateReviewItem(idx, 'expiryDate', e.target.value)} className="w-full bg-transparent border-b text-xs" placeholder="Expiry" /></div></div>))}</div></div>
                        <div className="p-6 border-t bg-gray-50 dark:bg-gray-800 flex justify-end gap-3"><button onClick={() => setReviewItems([])} className="px-4 py-2 rounded hover:bg-gray-200">Cancel</button><button onClick={handleConfirmReview} className="px-6 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700">Confirm All</button></div>
                    </div>
                </div>
            )}
            {editingItem && <EditItemModal item={editingItem} onClose={() => setEditingItem(null)} onSave={handleUpdateItem} />}
            {showAddItemModal && <AddItemModal onClose={() => setShowAddItemModal(false)} onAdd={handleManualAddItem} />}
            {bulkPromoContent && <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"><div className="bg-white dark:bg-gray-800 p-6 rounded-xl max-w-sm"><h3 className="font-bold text-xl mb-4">Promo Ready!</h3><p className="bg-gray-100 p-4 rounded italic mb-4 text-black">{bulkPromoContent}</p><button onClick={() => setBulkPromoContent(null)} className="w-full bg-indigo-600 text-white py-2 rounded">Close</button></div></div>}
            {isGeneratingBulkPromo && <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center"><div className="bg-white p-6 rounded-xl"><p>Generating Promo...</p></div></div>}
            {showSubscriptionModal && <SubscriptionModal onClose={() => setShowSubscriptionModal(false)} />}
        </main>
    );
};

export default InventoryManager;