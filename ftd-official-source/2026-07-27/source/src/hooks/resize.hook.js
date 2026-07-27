import { useLayoutEffect, useState} from "react";


export const useWindowSize = (listRef, varSizeList, isInput) => { // set board minimum size 
  // console.log(listRef, varSizeList, isInput)
  const [size, setSize] = useState([0,0,0,0,0,0,0]);
  const VPHeight = window.visualViewport.height
  const maxWidth = 500

  useLayoutEffect(() => {
    const updateSize = () => {
      const width = window.innerWidth
      const height = window.innerHeight
      const listWidth = Math.min(width * 0.98, maxWidth * 0.98)
      const rowHeight = 61
      // console.log('useWindowSize', VPHeight, height, window.height)
      let offsetY
      let rowHeightExpanded
      let boardSize
      let gameBoard

      if (width <= maxWidth && width <= height) { // portrait
        if (rowHeightExpanded > Math.ceil(height - offsetY) && width <= height) {
          offsetY = 126
          boardSize = Math.max (Math.min (listWidth, (height - offsetY - rowHeight - 121)), 313.6)
          gameBoard = Math.max (Math.min (width, (height - offsetY - 121)), 313.6)
          rowHeightExpanded = boardSize + 136 + rowHeight 
        } else {
          offsetY = width * 0.3402  + 136 
          boardSize = Math.max (Math.min (listWidth, (height - offsetY - rowHeight - 121)), 313.6)
          rowHeightExpanded = boardSize + 136 + rowHeight  //margins
        }
        // console.log('hi 1')
      }

      if (width > maxWidth ) { // portrait && width <= height
        offsetY = 350
        boardSize = Math.max (Math.min (listWidth, (height - offsetY - rowHeight - 155.5)), 313.6)
        rowHeightExpanded = boardSize + 136 + rowHeight 
      }
        
      setSize([width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize, gameBoard]);
      
    };
    if (!isInput) {
      window.addEventListener("resize", updateSize);
    }
    updateSize();
    return () => {
        window.removeEventListener("resize", updateSize);
    }
  }, []);

  if(listRef?.current && varSizeList) {
    listRef?.current.resetAfterIndex(0);
  }
  
  return size;
};