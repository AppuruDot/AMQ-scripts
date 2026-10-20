
// ==UserScript==
// @name         Eru Newbies
// @namespace    https://github.com/klouie1092
// @version      0.2.6
// @description  Eru Newbies game mode for AMQ
// @author       Shinks
// @match        https://*.animemusicquiz.com/*
// @grant        none
// @require      https://github.com/joske2865/AMQ-Scripts/raw/master/common/amqScriptInfo.js
// @icon         https://www.google.com/s2/favicons?sz=64&domain=animemusicquiz.com
// ==/UserScript==

"use strict";

(function () {
    const MAX_LIVES = 20;
    const REQUIRED_PLAYERS = 8;
    const DEFAULT_LIVES = 10;
    const COMMAND_PREFIX = "/";

    let eruModeInProgress = false;
    let eruState = null;
    let commands = true;

    if (typeof Listener === "undefined") return;

    // Wait for AMQ to finish loading.
    const loadInterval = setInterval(() => {
        if (document.querySelector("#loadingScreen.hidden")) {
            clearInterval(loadInterval);
            setup();
        }
    }, 500);

    function setup() {
        new Listener("game chat update", (data) => {
            if (!data || !Array.isArray(data.messages)) return;

            for (const message of data.messages) {
                if (!message || message.sender !== selfName) continue;

                if (
                    typeof message.message !== "string" ||
                    !/^\/neru(?:\s|$)/i.test(message.message.trim())
                ) {
                    continue;
                }

                parseCommand(message.message);
            }
        }).bindListener();

        new Listener("answer results", (result) => {
            if (eruModeInProgress) {
                processAnswerResults(result);
            }
        }).bindListener();

        console.log("[Eru Newbies] Listeners registered.");
    }

    function sendChatMessage(msg) {
        if (!socket?.sendCommand) {
            console.warn("[Eru Newbies] AMQ socket is unavailable.");
            return;
        }

        socket.sendCommand({
            type: "lobby",
            command: "game chat message",
            data: {
                msg,
                teamMessage: false
            }
        });
    }

    function parseCommand(input) {
        const parts = input.trim().split(/\s+/);
        const command = parts[0].slice(COMMAND_PREFIX.length).toLowerCase();
        const args = parts.slice(1);

        if (command === "commands" && args[0]?.toLowerCase() === "on") {
            commands = true;
            sendChatMessage("Commands enabled.");
            return;
        }

        if (!commands || command !== "neru") return;

        if (args[0]?.toLowerCase() === "stop") {
            if (eruModeInProgress) {
                stopEruGame("Eru Newbies stopped.");
            } else {
                sendChatMessage("No Eru Newbies game is currently running.");
            }
            return;
        }

        if (args.length > 1) {
            sendChatMessage("Usage: /neru [number of lives] or /neru stop");
            return;
        }

        const initialLives = args.length === 0
            ? DEFAULT_LIVES
            : Number(args[0]);

        if (!Number.isInteger(initialLives) || initialLives <= 0) {
            sendChatMessage("Please enter a positive whole number of lives.");
            return;
        }

        if (eruModeInProgress) {
            sendChatMessage("Eru Newbies is already in progress.");
            return;
        }

        if (typeof quiz === "undefined" || !quiz?.players) {
            sendChatMessage("Unable to read the current lobby players.");
            return;
        }

        const players = getOrderedPlayers();

        if (players.length !== REQUIRED_PLAYERS) {
            sendChatMessage(
                `Eru Newbies requires exactly ${REQUIRED_PLAYERS} players.`
            );
            return;
        }

        const teamNumbers = players.map(player => player.teamNumber);

        if (
            teamNumbers.some(number => number === undefined || number === null) ||
            new Set(teamNumbers).size !== REQUIRED_PLAYERS
        ) {
            sendChatMessage(
                "Unable to determine the player order. Please check the lobby."
            );
            return;
        }

        eruState = {
            initialLives,
            currentTeam1: initialLives,
            currentTeam2: initialLives,
            songsPlayed: 0,
            suddenDeath: false
        };

        eruModeInProgress = true;

        sendChatMessage(
            `Neru Newbies started with ${initialLives} lives per team!`
        );

        sendEruScore();
    }

    function getOrderedPlayers() {
        if (typeof quiz === "undefined" || !quiz?.players) return [];

        return Object.values(quiz.players).sort(
            (a, b) => Number(a.teamNumber) - Number(b.teamNumber)
        );
    }

    function processAnswerResults(result) {
        if (!eruModeInProgress || !eruState) return;

        const players = getOrderedPlayers();

        if (players.length !== REQUIRED_PLAYERS) {
            stopEruGame("Player count changed. Eru Newbies stopped.");
            return;
        }

        const resultsByPlayer = new Map();

        for (const playerResult of result.players || []) {
            resultsByPlayer.set(
                playerResult.gamePlayerId,
                playerResult.correct === true
            );
        }

        // Positions A-H correspond to the ordered player list.
        const correct = players.map(
            player => resultsByPlayer.get(player.gamePlayerId) === true
        );

        const playerNames = players.map(player => player.name);

        // Count the completed song.
        eruState.songsPlayed += 1;

        // Everyone correct means no lives change, even during sudden death.
        if (correct.every(answeredCorrectly => answeredCorrectly)) {
            sendChatMessage("Everyone got the song right! No lives changed.");
            sendEruScore();

            // Activate sudden death after song 25, for song 26 onward.
            if (eruState.songsPlayed === 25) {
                activateSuddenDeath();
            }
            return;
        }

        // A and E heal their respective teams by 1, up to 20 lives.
        let leftHeal = 0;
        let rightHeal = 0;

        if (correct[0] && eruState.currentTeam1 < MAX_LIVES) {
            leftHeal = 1;
        }

        if (correct[4] && eruState.currentTeam2 < MAX_LIVES) {
            rightHeal = 1;
        }

        eruState.currentTeam1 = Math.min(
            MAX_LIVES,
            eruState.currentTeam1 + leftHeal
        );

        eruState.currentTeam2 = Math.min(
            MAX_LIVES,
            eruState.currentTeam2 + rightHeal
        );

        if (leftHeal > 0) {
            sendChatMessage("Left team has healed 1 life!");
        }

        if (rightHeal > 0) {
            sendChatMessage("Right team has healed 1 life!");
        }

        // B supports newbies C and D.
        // F supports newbies G and H.
        // Normal damage: 1 per correct newbie.
        // If their Pro is correct, that newbie deals 2 damage.
        // During sudden death, all newbie damage is doubled.
        let damageToLeft = 0;
        let damageToRight = 0;

        const leftDoubled = [];
        const rightDoubled = [];

        // C and D attack the right team.
        if (correct[2]) {
            const damage = correct[1] ? 2 : 1;
            damageToRight += eruState.suddenDeath ? damage * 2 : damage;

            if (correct[1] || eruState.suddenDeath) {
                leftDoubled.push("C");
            }
        }

        if (correct[3]) {
            const damage = correct[1] ? 2 : 1;
            damageToRight += eruState.suddenDeath ? damage * 2 : damage;

            if (correct[1] || eruState.suddenDeath) {
                leftDoubled.push("D");
            }
        }

        // G and H attack the left team.
        if (correct[6]) {
            const damage = correct[5] ? 2 : 1;
            damageToLeft += eruState.suddenDeath ? damage * 2 : damage;

            if (correct[5] || eruState.suddenDeath) {
                rightDoubled.push("G");
            }
        }

        if (correct[7]) {
            const damage = correct[5] ? 2 : 1;
            damageToLeft += eruState.suddenDeath ? damage * 2 : damage;

            if (correct[5] || eruState.suddenDeath) {
                rightDoubled.push("H");
            }
        }

        const leftProName = playerNames[1];
        const rightProName = playerNames[5];

        const newbieNames = {
            C: playerNames[2],
            D: playerNames[3],
            G: playerNames[6],
            H: playerNames[7]
        };

        if (eruState.suddenDeath) {
            if (leftDoubled.length > 0) {
                sendChatMessage(
                    `Sudden death: ${leftDoubled.map(role => newbieNames[role]).join(" and ")} dealt double damage!`
                );
            }

            if (rightDoubled.length > 0) {
                sendChatMessage(
                    `Sudden death: ${rightDoubled.map(role => newbieNames[role]).join(" and ")} dealt double damage!`
                );
            }
        } else {
            if (leftDoubled.length === 2) {
                sendChatMessage(
                    `${leftProName} has doubled ${newbieNames.C} and ${newbieNames.D}'s damage to 4 damage!`
                );
            } else if (leftDoubled.length === 1) {
                const newbieName = newbieNames[leftDoubled[0]];
                sendChatMessage(
                    `${leftProName} has doubled ${newbieName}'s damage to 2 damage!`
                );
            }

            if (rightDoubled.length === 2) {
                sendChatMessage(
                    `${rightProName} has doubled ${newbieNames.G} and ${newbieNames.H}'s damage to 4 damage!`
                );
            } else if (rightDoubled.length === 1) {
                const newbieName = newbieNames[rightDoubled[0]];
                sendChatMessage(
                    `${rightProName} has doubled ${newbieName}'s damage to 2 damage!`
                );
            }
        }

        // Apply damage after healing and attack calculations.
        eruState.currentTeam1 = Math.max(
            0,
            eruState.currentTeam1 - damageToLeft
        );

        eruState.currentTeam2 = Math.max(
            0,
            eruState.currentTeam2 - damageToRight
        );

        sendEruScore();

        // Announce sudden death after song 25, for song 26 onward.
        if (eruState.songsPlayed === 25) {
            activateSuddenDeath();
        }

        // Determine the winner after all effects have been applied.
        if (
            eruState.currentTeam1 <= 0 &&
            eruState.currentTeam2 <= 0
        ) {
            stopEruGame("Eru Newbies ended in a draw!");
        } else if (eruState.currentTeam1 <= 0) {
            stopEruGame("Eru Newbies completed! Right team wins!");
        } else if (eruState.currentTeam2 <= 0) {
            stopEruGame("Eru Newbies completed! Left team wins!");
        }
    }

    function activateSuddenDeath() {
        if (!eruState || eruState.suddenDeath) return;

        eruState.suddenDeath = true;
        sendChatMessage("SUDDEN DEATH! Newbies' damage is now doubled!");
    }

    function sendEruScore() {
        if (!eruState) return;

        sendChatMessage(
            `Eru Newbies: ${eruState.currentTeam1}-${eruState.currentTeam2}`
        );
    }

    function stopEruGame(message) {
        eruModeInProgress = false;
        eruState = null;
        sendChatMessage(message);
    }
})();
